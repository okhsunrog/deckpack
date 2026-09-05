//! Vertical ray sampling of the inner surface.

use rayon::prelude::*;

use crate::stl::Triangle;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DepthMapOptions {
    /// Grid pitch in the deck plane.
    pub step_mm: f64,
    /// Depth resolution of the stored `u8` samples.
    pub quantization_mm: f64,
    /// Rays start below the open side and travel toward the floor.
    pub ray_origin_z_mm: f64,
    /// Only faces whose (source-space) normal points toward the open side
    /// count as the inner surface.
    pub inward_normal_z_limit: f64,
    /// Margin added around footprints when the planner queries the map.
    pub safety_margin_mm: f64,
}

impl Default for DepthMapOptions {
    fn default() -> Self {
        Self {
            step_mm: 0.5,
            quantization_mm: 0.25,
            ray_origin_z_mm: -1.0,
            inward_normal_z_limit: -0.02,
            safety_margin_mm: 0.5,
        }
    }
}

/// A grid of quantised depths in app coordinates.
pub struct SampledDepthMap {
    pub columns: usize,
    pub rows: usize,
    pub origin_mm: [f64; 2],
    pub step_mm: f64,
    pub quantization_mm: f64,
    /// Row-major `u8` depth units, 0 = no floor (wall or outside).
    pub data: Vec<u8>,
}

impl SampledDepthMap {
    pub fn decoded(&self, row: usize, column: usize) -> f64 {
        self.data[row * self.columns + column] as f64 * self.quantization_mm
    }

    pub fn usable_volume_mm3(&self) -> f64 {
        let sum: f64 = self
            .data
            .iter()
            .map(|&value| value as f64 * self.quantization_mm)
            .sum();
        sum * self.step_mm * self.step_mm
    }

    pub fn depth_range(&self) -> Option<(f64, f64)> {
        let mut range: Option<(f64, f64)> = None;
        for &value in &self.data {
            if value == 0 {
                continue;
            }
            let depth = value as f64 * self.quantization_mm;
            range = Some(match range {
                Some((min, max)) => (min.min(depth), max.max(depth)),
                None => (depth, depth),
            });
        }
        range
    }
}

/// A triangle already projected into the sampling frame: `xy` in app
/// coordinates, `z` the source depth, `inward` whether the source normal faces
/// the open side.
struct ProjectedTriangle {
    xy: [[f64; 2]; 3],
    z: [f64; 3],
    inward: bool,
}

/// Sample the surface. `project` maps a source vertex to `(app_x, app_y)`;
/// depth is the untouched source `z`.
pub fn sample_depth_map(
    triangles: &[Triangle],
    project: impl Fn([f64; 3]) -> [f64; 2] + Sync,
    columns: usize,
    rows: usize,
    origin_mm: [f64; 2],
    options: &DepthMapOptions,
) -> SampledDepthMap {
    let step = options.step_mm;
    let projected: Vec<ProjectedTriangle> = triangles
        .iter()
        .map(|triangle| {
            let normal = triangle.raw_normal();
            let len =
                (normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]).sqrt();
            let inward = len > 0.0 && normal[2] / len < options.inward_normal_z_limit;
            ProjectedTriangle {
                xy: triangle.vertices.map(&project),
                z: triangle.vertices.map(|v| v[2]),
                inward,
            }
        })
        .collect();

    // Bin the inward-facing triangles by the grid cells their footprint covers.
    let mut bins: Vec<Vec<u32>> = vec![Vec::new(); columns * rows];
    for (index, triangle) in projected.iter().enumerate() {
        if !triangle.inward {
            continue;
        }
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        );
        for [x, y] in triangle.xy {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
        let c0 = ((min_x - origin_mm[0]) / step).floor().max(0.0) as usize;
        let c1 = ((max_x - origin_mm[0]) / step)
            .ceil()
            .min(columns as f64 - 1.0);
        let r0 = ((min_y - origin_mm[1]) / step).floor().max(0.0) as usize;
        let r1 = ((max_y - origin_mm[1]) / step)
            .ceil()
            .min(rows as f64 - 1.0);
        if c1 < 0.0 || r1 < 0.0 {
            continue;
        }
        for row in r0..=r1 as usize {
            for column in c0..=c1 as usize {
                bins[row * columns + column].push(index as u32);
            }
        }
    }

    let data: Vec<u8> = (0..rows)
        .into_par_iter()
        .flat_map_iter(|row| {
            let projected = &projected;
            let bins = &bins;
            (0..columns).map(move |column| {
                let x = origin_mm[0] + column as f64 * step;
                let y = origin_mm[1] + row as f64 * step;
                let mut depth = f64::INFINITY;
                for &index in &bins[row * columns + column] {
                    if let Some(z) = vertical_hit(&projected[index as usize], x, y)
                        && z >= options.ray_origin_z_mm
                    {
                        depth = depth.min(z);
                    }
                }
                if !depth.is_finite() || depth <= options.quantization_mm / 2.0 {
                    return 0u8;
                }
                (depth / options.quantization_mm)
                    .round_ties_even()
                    .clamp(1.0, 255.0) as u8
            })
        })
        .collect();

    SampledDepthMap {
        columns,
        rows,
        origin_mm,
        step_mm: step,
        quantization_mm: options.quantization_mm,
        data,
    }
}

/// Depth of the vertical ray through `(x, y)` on the triangle, if inside it.
fn vertical_hit(triangle: &ProjectedTriangle, x: f64, y: f64) -> Option<f64> {
    let [[x0, y0], [x1, y1], [x2, y2]] = triangle.xy;
    let denominator = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if denominator.abs() < 1e-18 {
        return None;
    }
    let l0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / denominator;
    let l1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / denominator;
    let l2 = 1.0 - l0 - l1;
    const EPS: f64 = 1e-9;
    if l0 < -EPS || l1 < -EPS || l2 < -EPS {
        return None;
    }
    Some(l0 * triangle.z[0] + l1 * triangle.z[1] + l2 * triangle.z[2])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 20×20 open box: floor at z = 10, walls up to z = 0, opening at z = 0
    /// facing −z like the Spark case source.
    fn open_box() -> Vec<Triangle> {
        let quad = |a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]| {
            [
                Triangle {
                    vertices: [a, b, c],
                },
                Triangle {
                    vertices: [a, c, d],
                },
            ]
        };
        let mut triangles = Vec::new();
        // Floor, normal pointing −z (toward the opening).
        triangles.extend(quad(
            [-10.0, -10.0, 10.0],
            [-10.0, 10.0, 10.0],
            [10.0, 10.0, 10.0],
            [10.0, -10.0, 10.0],
        ));
        // Inner walls (vertical faces are ignored by the normal filter anyway).
        triangles.extend(quad(
            [-10.0, -10.0, 0.0],
            [10.0, -10.0, 0.0],
            [10.0, -10.0, 10.0],
            [-10.0, -10.0, 10.0],
        ));
        triangles
    }

    #[test]
    fn floor_depth_is_sampled_and_outside_is_wall() {
        let triangles = open_box();
        let options = DepthMapOptions::default();
        let map = sample_depth_map(
            &triangles,
            |v| [v[1], v[0]],
            61,
            61,
            [-15.0, -15.0],
            &options,
        );
        assert_eq!(map.decoded(30, 30), 10.0);
        assert_eq!(map.decoded(30, 10), 10.0); // x = -10 edge still inside
        assert_eq!(map.data[0], 0); // corner outside the box
        assert_eq!(map.depth_range(), Some((10.0, 10.0)));
    }
}
