//! Sampled inner surface of a profiled enclosure and the depth queries the
//! planner runs against it.
//!
//! The depth map is a row-major `u8` grid in quantisation units (0 = wall).
//! Range-minimum queries over rows and columns are answered from sparse
//! tables so a whole footprint costs O(rows) instead of O(rows × columns).

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use base64::Engine;

use crate::assets;
use crate::types::{Axis, Dimensions3D, EnclosureSpec};

#[derive(Debug, thiserror::Error)]
pub enum HeightMapError {
    #[error(transparent)]
    Asset(#[from] assets::AssetError),
    #[error("height map `{id}` is corrupt: {reason}")]
    Corrupt { id: String, reason: String },
}

/// A `mesh-heightmap` enclosure: the asset id plus the inner box it spans.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HeightMapEnclosure<'a> {
    pub asset_id: &'a str,
    pub dimensions_mm: &'a Dimensions3D,
}

impl HeightMapEnclosure<'_> {
    /// Z of the lid plane; the enclosure is centred on the origin.
    pub fn top_z(&self) -> f64 {
        self.dimensions_mm.height / 2.0
    }
}

impl EnclosureSpec {
    pub fn as_height_map(&self) -> Option<HeightMapEnclosure<'_>> {
        match self {
            EnclosureSpec::MeshHeightmap {
                asset_id,
                dimensions_mm,
            } => Some(HeightMapEnclosure {
                asset_id,
                dimensions_mm,
            }),
            EnclosureSpec::Box { .. } => None,
        }
    }
}

#[derive(Debug)]
pub struct CompiledHeightMap {
    pub columns: usize,
    pub rows: usize,
    pub origin: [f64; 2],
    pub step_mm: f64,
    pub quantization_mm: f64,
    pub safety_margin_mm: f64,
    pub usable_volume_mm3: f64,
    /// `levels[k][row * columns + c]` = min depth over columns `c ..= c + 2^k - 1`.
    levels: Vec<Vec<u8>>,
    /// `row_levels[k][r * columns + column]` = min depth over rows `r ..= r + 2^k - 1`.
    row_levels: Vec<Vec<u8>>,
}

impl CompiledHeightMap {
    fn compile(id: &str) -> Result<Self, HeightMapError> {
        assets::with_asset(id, |asset| {
            let map = &asset.depth_map;
            let (columns, rows) = (map.columns as usize, map.rows as usize);
            let base = base64::engine::general_purpose::STANDARD
                .decode(&map.data_base64)
                .map_err(|error| HeightMapError::Corrupt {
                    id: id.to_owned(),
                    reason: error.to_string(),
                })?;
            if base.len() != columns * rows {
                return Err(HeightMapError::Corrupt {
                    id: id.to_owned(),
                    reason: format!("{} samples for a {columns}x{rows} grid", base.len()),
                });
            }

            let mut levels = vec![base.clone()];
            let mut span = 1;
            while span * 2 <= columns {
                let previous = levels.last().unwrap();
                let mut next = vec![0u8; previous.len()];
                for row in 0..rows {
                    let offset = row * columns;
                    for column in 0..columns {
                        let right = (column + span).min(columns - 1);
                        next[offset + column] =
                            previous[offset + column].min(previous[offset + right]);
                    }
                }
                levels.push(next);
                span *= 2;
            }

            let mut row_levels = vec![base];
            let mut span = 1;
            while span * 2 <= rows {
                let previous = row_levels.last().unwrap();
                let mut next = vec![0u8; previous.len()];
                for row in 0..rows {
                    let below = (row + span).min(rows - 1);
                    for column in 0..columns {
                        next[row * columns + column] = previous[row * columns + column]
                            .min(previous[below * columns + column]);
                    }
                }
                row_levels.push(next);
                span *= 2;
            }

            Ok(Self {
                columns,
                rows,
                origin: map.origin_mm,
                step_mm: map.step_mm,
                quantization_mm: map.depth_quantization_mm,
                safety_margin_mm: map.safety_margin_mm,
                usable_volume_mm3: map.usable_volume_mm3,
                levels,
                row_levels,
            })
        })?
    }

    /// Raw sample in quantisation units.
    #[inline]
    pub fn sample(&self, row: usize, column: usize) -> u8 {
        self.levels[0][row * self.columns + column]
    }

    /// Minimum over `first_column ..= last_column` of one row.
    pub fn row_range_min(&self, row: usize, first_column: usize, last_column: usize) -> u8 {
        let length = last_column - first_column + 1;
        let level = length.ilog2() as usize;
        let span = 1usize << level;
        let values = &self.levels[level];
        let offset = row * self.columns;
        values[offset + first_column].min(values[offset + last_column - span + 1])
    }

    /// Minimum over `first_row ..= last_row` of one column.
    pub fn column_range_min(&self, column: usize, first_row: usize, last_row: usize) -> u8 {
        let length = last_row - first_row + 1;
        let level = length.ilog2() as usize;
        let span = 1usize << level;
        let values = &self.row_levels[level];
        values[first_row * self.columns + column]
            .min(values[(last_row - span + 1) * self.columns + column])
    }

    #[inline]
    pub fn column_at(&self, x: f64) -> f64 {
        (x - self.origin[0]) / self.step_mm
    }

    #[inline]
    pub fn row_at(&self, y: f64) -> f64 {
        (y - self.origin[1]) / self.step_mm
    }

    /// Inclusive index window `[floor(lo), ceil(hi)]` if it lies inside `0..limit`.
    fn window(lo: f64, hi: f64, limit: usize) -> Option<(usize, usize)> {
        let (first, last) = (lo.floor(), hi.ceil());
        if first < 0.0 || last >= limit as f64 {
            return None;
        }
        Some((first as usize, last as usize))
    }

    pub fn column_window(&self, x_min: f64, x_max: f64) -> Option<(usize, usize)> {
        Self::window(self.column_at(x_min), self.column_at(x_max), self.columns)
    }

    pub fn row_window(&self, y_min: f64, y_max: f64) -> Option<(usize, usize)> {
        Self::window(self.row_at(y_min), self.row_at(y_max), self.rows)
    }
}

static COMPILED: RwLock<Option<HashMap<String, Arc<CompiledHeightMap>>>> = RwLock::new(None);

/// Compile (or fetch from cache) the height map behind an enclosure.
pub fn compiled(
    enclosure: HeightMapEnclosure<'_>,
) -> Result<Arc<CompiledHeightMap>, HeightMapError> {
    if let Some(cached) = COMPILED
        .read()
        .expect("height map cache poisoned")
        .as_ref()
        .and_then(|cache| cache.get(enclosure.asset_id))
    {
        return Ok(cached.clone());
    }
    let map = Arc::new(CompiledHeightMap::compile(enclosure.asset_id)?);
    COMPILED
        .write()
        .expect("height map cache poisoned")
        .get_or_insert_with(HashMap::new)
        .insert(enclosure.asset_id.to_owned(), map.clone());
    Ok(map)
}

/// Compiles the height map once so later queries can unwrap it.
pub fn ensure_compiled(spec: &EnclosureSpec) -> Result<(), HeightMapError> {
    match spec.as_height_map() {
        Some(enclosure) => compiled(enclosure).map(drop),
        None => Ok(()),
    }
}

/// Cached map for an enclosure whose asset was validated with
/// [`ensure_compiled`]; the planner never runs against an unknown asset.
pub(crate) fn map_for(enclosure: HeightMapEnclosure<'_>) -> Arc<CompiledHeightMap> {
    compiled(enclosure)
        .unwrap_or_else(|error| panic!("height map `{}` unavailable: {error}", enclosure.asset_id))
}

/// A finished cell as the profile kernel sees it: the axis-aligned cylinder
/// that must clear the inner surface. Radius and half-length include the
/// per-cell tolerance layers plus the outer wrap.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProfileCylinder {
    pub center_x_mm: f64,
    pub center_y_mm: f64,
    pub axis: Axis,
    pub radius_mm: f64,
    pub half_length_mm: f64,
}

/// Highest allowed cylinder-centre z before the cell pokes through the lid.
pub fn cylinder_top_limit_z(enclosure: HeightMapEnclosure<'_>, cylinder: &ProfileCylinder) -> f64 {
    let reach = if cylinder.axis == Axis::Z {
        cylinder.half_length_mm
    } else {
        cylinder.radius_mm
    };
    enclosure.top_z() - reach
}

/// Lowest cylinder-centre z at which the cell does not penetrate the inner
/// surface. A horizontal cylinder's underside rises toward its sides by
/// `sqrt(r² − d²)`, so a cell may legitimately overhang a ramp that its
/// bounding box would collide with. `INFINITY` when the footprint leaves the
/// sampled grid (treated as a wall).
pub fn min_cylinder_center_z(enclosure: HeightMapEnclosure<'_>, cylinder: &ProfileCylinder) -> f64 {
    let map = map_for(enclosure);
    let margin = map.safety_margin_mm;
    let half_step = map.step_mm / 2.0;
    let top_z = enclosure.top_z();
    let ProfileCylinder {
        center_x_mm,
        center_y_mm,
        radius_mm,
        half_length_mm,
        axis,
    } = *cylinder;

    if axis != Axis::Z {
        let axial_along_x = axis == Axis::X;
        let (axial, lateral) = if axial_along_x {
            (center_x_mm, center_y_mm)
        } else {
            (center_y_mm, center_x_mm)
        };
        let axial_window = if axial_along_x {
            map.column_window(
                axial - half_length_mm - margin,
                axial + half_length_mm + margin,
            )
        } else {
            map.row_window(
                axial - half_length_mm - margin,
                axial + half_length_mm + margin,
            )
        };
        let lateral_window = if axial_along_x {
            map.row_window(lateral - radius_mm - margin, lateral + radius_mm + margin)
        } else {
            map.column_window(lateral - radius_mm - margin, lateral + radius_mm + margin)
        };
        let (Some((a0, a1)), Some((l0, l1))) = (axial_window, lateral_window) else {
            return f64::INFINITY;
        };
        let lateral_origin = if axial_along_x {
            map.origin[1]
        } else {
            map.origin[0]
        };
        let mut min_center = f64::NEG_INFINITY;
        for line in l0..=l1 {
            let line_coordinate = lateral_origin + line as f64 * map.step_mm;
            let offset = ((line_coordinate - lateral).abs() - half_step - margin).max(0.0);
            if offset >= radius_mm {
                continue;
            }
            let quantized = if axial_along_x {
                map.row_range_min(line, a0, a1)
            } else {
                map.column_range_min(line, a0, a1)
            };
            let depth = quantized as f64 * map.quantization_mm;
            let surface_drop = (radius_mm * radius_mm - offset * offset).sqrt();
            min_center = min_center.max(top_z - depth + surface_drop);
        }
        return min_center;
    }

    let Some((r0, r1)) = map.row_window(
        center_y_mm - radius_mm - margin,
        center_y_mm + radius_mm + margin,
    ) else {
        return f64::INFINITY;
    };
    let mut min_center = f64::NEG_INFINITY;
    for row in r0..=r1 {
        let y = map.origin[1] + row as f64 * map.step_mm;
        let offset = ((y - center_y_mm).abs() - half_step - margin).max(0.0);
        if offset >= radius_mm {
            continue;
        }
        let half_width = (radius_mm * radius_mm - offset * offset).sqrt();
        let Some((c0, c1)) = map.column_window(
            center_x_mm - half_width - margin,
            center_x_mm + half_width + margin,
        ) else {
            return f64::INFINITY;
        };
        let depth = map.row_range_min(row, c0, c1) as f64 * map.quantization_mm;
        min_center = min_center.max(top_z - depth + half_length_mm);
    }
    min_center
}

/// True when the cylinder at its given centre z fits the profile and the lid.
pub fn cylinder_fits_profile(
    enclosure: HeightMapEnclosure<'_>,
    cylinder: &ProfileCylinder,
    center_z_mm: f64,
) -> bool {
    center_z_mm + crate::geometry::EPSILON >= min_cylinder_center_z(enclosure, cylinder)
        && center_z_mm <= cylinder_top_limit_z(enclosure, cylinder) + crate::geometry::EPSILON
}

#[cfg(test)]
pub(crate) mod test_support {
    use base64::Engine;

    use crate::types::{DepthMap, Dimensions3D, EnclosureSpec, HeightMapAsset, HeightMapKind};

    pub const RAMP_ID: &str = "test-ramp";

    /// Deep 46 mm floor for x < 0, a linear ramp rising 1.2 mm per mm over
    /// 0..10, then a 34 mm shelf: the shape that forces the AABB-vs-cylinder
    /// distinction near the Spark case ramp.
    pub fn register_ramp() -> EnclosureSpec {
        let step_mm = 0.5;
        let (columns, rows) = (121usize, 81usize);
        let origin = [-30.0, -20.0];
        let mut data = vec![0u8; columns * rows];
        for row in 0..rows {
            for column in 0..columns {
                let x = origin[0] + column as f64 * step_mm;
                let depth = if x < 0.0 {
                    46.0
                } else if x < 10.0 {
                    46.0 - 1.2 * x
                } else {
                    34.0
                };
                data[row * columns + column] = (depth / 0.25).round() as u8;
            }
        }
        let dimensions_mm = Dimensions3D {
            length: 60.0,
            width: 40.0,
            height: 50.0,
        };
        crate::assets::register(HeightMapAsset {
            id: RAMP_ID.into(),
            label: "Test ramp".into(),
            kind: HeightMapKind::MeshHeightmap,
            dimensions_mm,
            model_url: String::new(),
            mesh_triangles: 0,
            depth_map: DepthMap {
                origin_mm: origin,
                step_mm,
                columns: columns as u32,
                rows: rows as u32,
                depth_quantization_mm: 0.25,
                safety_margin_mm: 0.5,
                min_depth_mm: 34.0,
                max_depth_mm: 46.0,
                usable_volume_mm3: 1.0,
                data_base64: base64::engine::general_purpose::STANDARD.encode(&data),
            },
        });
        EnclosureSpec::MeshHeightmap {
            asset_id: RAMP_ID.into(),
            dimensions_mm,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::register_ramp;
    use super::*;
    use crate::geometry::{available_depth_for_box, box_from_center_size};

    const RADIUS: f64 = 11.0;
    const HALF_LENGTH: f64 = 15.0;
    /// Resting on the deep floor.
    const DEEP_REST_Z: f64 = 50.0 / 2.0 - 46.0 + RADIUS;

    fn cylinder(center_x: f64) -> ProfileCylinder {
        ProfileCylinder {
            center_x_mm: center_x,
            center_y_mm: 0.0,
            axis: Axis::Y,
            radius_mm: RADIUS,
            half_length_mm: HALF_LENGTH,
        }
    }

    #[test]
    fn horizontal_cell_may_overhang_a_ramp_its_box_would_hit() {
        let spec = register_ramp();
        let enclosure = spec.as_height_map().unwrap();
        let footprint =
            box_from_center_size([-8.0, 0.0, 0.0], [RADIUS * 2.0, HALF_LENGTH * 2.0, 0.0]);
        assert!(available_depth_for_box(&spec, &footprint) < 46.0);
        let rest = min_cylinder_center_z(enclosure, &cylinder(-8.0));
        assert!((rest - DEEP_REST_Z).abs() < 1e-6, "{rest} vs {DEEP_REST_Z}");
        assert!(cylinder_fits_profile(
            enclosure,
            &cylinder(-8.0),
            DEEP_REST_Z
        ));
    }

    #[test]
    fn real_intersection_with_the_ramp_is_rejected() {
        let spec = register_ramp();
        let enclosure = spec.as_height_map().unwrap();
        assert!(min_cylinder_center_z(enclosure, &cylinder(2.0)) > DEEP_REST_Z + 1.0);
        assert!(!cylinder_fits_profile(
            enclosure,
            &cylinder(2.0),
            DEEP_REST_Z
        ));
    }

    #[test]
    fn leaving_the_grid_is_a_wall() {
        let spec = register_ramp();
        let enclosure = spec.as_height_map().unwrap();
        assert_eq!(
            min_cylinder_center_z(enclosure, &cylinder(-25.0)),
            f64::INFINITY
        );
    }

    #[test]
    fn spark_case_uses_the_inner_surface() {
        let spec = EnclosureSpec::MeshHeightmap {
            asset_id: "spark-case".into(),
            dimensions_mm: Dimensions3D {
                length: 339.4,
                width: 212.3,
                height: 50.0,
            },
        };
        let shallow = box_from_center_size([-95.0, 0.0, 0.0], [2.0, 2.0, 0.0]);
        let deep = box_from_center_size([50.0, 0.0, 0.0], [2.0, 2.0, 0.0]);
        assert_eq!(available_depth_for_box(&spec, &shallow), 36.0);
        assert_eq!(available_depth_for_box(&spec, &deep), 48.0);
        // The seam remnant of the printable halves is flattened out.
        for x in -30..=20 {
            let probe = box_from_center_size([x as f64, 0.0, 0.0], [1.0, 60.0, 0.0]);
            assert_eq!(available_depth_for_box(&spec, &probe), 48.0, "x = {x}");
        }
    }
}
