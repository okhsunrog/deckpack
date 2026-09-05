//! Meshes of planner results for CAD and slicers.

use deckpack_core::{Axis, CellSpec, PackPlan, Vec3};

use crate::stl::{Triangle, write_binary_stl};

/// Closed cylinder along `axis` centred at `center`, tessellated with
/// `segments` facets around.
pub fn cylinder(
    center: Vec3,
    axis: Axis,
    radius: f64,
    length: f64,
    segments: usize,
) -> Vec<Triangle> {
    let a = axis.index();
    let (u, v) = match axis {
        Axis::X => (1, 2),
        Axis::Y => (0, 2),
        Axis::Z => (0, 1),
    };
    let point = |angle: f64, along: f64| -> Vec3 {
        let mut p = center;
        p[a] += along;
        p[u] += radius * angle.cos();
        p[v] += radius * angle.sin();
        p
    };
    let mut end_lo = center;
    end_lo[a] -= length / 2.0;
    let mut end_hi = center;
    end_hi[a] += length / 2.0;
    let mut triangles = Vec::with_capacity(segments * 4);
    for i in 0..segments {
        let a0 = i as f64 / segments as f64 * std::f64::consts::TAU;
        let a1 = (i + 1) as f64 / segments as f64 * std::f64::consts::TAU;
        let (p00, p01) = (point(a0, -length / 2.0), point(a1, -length / 2.0));
        let (p10, p11) = (point(a0, length / 2.0), point(a1, length / 2.0));
        // Side, outward facing for a right-handed (u, v, a) frame.
        triangles.push(Triangle {
            vertices: [p00, p01, p11],
        });
        triangles.push(Triangle {
            vertices: [p00, p11, p10],
        });
        // Caps.
        triangles.push(Triangle {
            vertices: [end_lo, p01, p00],
        });
        triangles.push(Triangle {
            vertices: [end_hi, p10, p11],
        });
    }
    // Y and Z axes give a left-handed (u, v, a) frame; flip the winding.
    if axis == Axis::Y {
        for triangle in &mut triangles {
            triangle.vertices.swap(1, 2);
        }
    }
    triangles
}

/// Every cell of the plan as a sleeved cylinder, in app coordinates.
pub fn cell_triangles(plan: &PackPlan, cell: &CellSpec, segments: usize) -> Vec<Triangle> {
    plan.cells
        .iter()
        .flat_map(|placed| {
            cylinder(
                placed.position,
                plan.orientation,
                cell.sleeved_diameter_mm / 2.0,
                cell.sleeved_height_mm,
                segments,
            )
        })
        .collect()
}

/// Binary STL of the plan's cells.
pub fn cells_stl(plan: &PackPlan, cell: &CellSpec, segments: usize) -> Vec<u8> {
    write_binary_stl(&cell_triangles(plan, cell, segments))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cylinder_is_closed_and_outward() {
        for axis in Axis::ALL {
            let triangles = cylinder([1.0, 2.0, 3.0], axis, 10.0, 70.0, 32);
            assert_eq!(triangles.len(), 32 * 4);
            // Every normal points away from the centre.
            for triangle in &triangles {
                let n = triangle.normal();
                let c = triangle
                    .vertices
                    .iter()
                    .fold([0.0; 3], |s, v| [s[0] + v[0], s[1] + v[1], s[2] + v[2]]);
                let dir = [c[0] / 3.0 - 1.0, c[1] / 3.0 - 2.0, c[2] / 3.0 - 3.0];
                assert!(
                    n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2] > 0.0,
                    "{axis:?}: inward-facing triangle"
                );
            }
        }
    }
}
