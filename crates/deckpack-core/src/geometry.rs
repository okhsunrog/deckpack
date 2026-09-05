//! Axis-aligned boxes, rotated footprints and the workspace evaluation that
//! checks placed components against the pack and the enclosure.

use crate::heightmap::{self, HeightMapError};
use crate::types::{
    Box3D, ComponentEvaluation, ComponentPlacement, Dimensions3D, EnclosureSpec, LargestFreeBox,
    PackPlan, Vec3, WorkspaceEvaluation,
};

pub const EPSILON: f64 = 1e-6;

/* ----------------------------------------------------------------- boxes */

pub fn enclosure_bounds(spec: &EnclosureSpec) -> Box3D {
    let Dimensions3D {
        length,
        width,
        height,
    } = *spec.dimensions_mm();
    Box3D {
        min: [-length / 2.0, -width / 2.0, -height / 2.0],
        max: [length / 2.0, width / 2.0, height / 2.0],
    }
}

pub fn box_from_center_size(center: Vec3, size: Vec3) -> Box3D {
    Box3D {
        min: [
            center[0] - size[0] / 2.0,
            center[1] - size[1] / 2.0,
            center[2] - size[2] / 2.0,
        ],
        max: [
            center[0] + size[0] / 2.0,
            center[1] + size[1] / 2.0,
            center[2] + size[2] / 2.0,
        ],
    }
}

pub fn box_size(b: &Box3D) -> Vec3 {
    [
        b.max[0] - b.min[0],
        b.max[1] - b.min[1],
        b.max[2] - b.min[2],
    ]
}

pub fn box_center(b: &Box3D) -> Vec3 {
    [
        (b.min[0] + b.max[0]) / 2.0,
        (b.min[1] + b.max[1]) / 2.0,
        (b.min[2] + b.max[2]) / 2.0,
    ]
}

pub fn box_volume(b: &Box3D) -> f64 {
    let size = box_size(b);
    size[0].max(0.0) * size[1].max(0.0) * size[2].max(0.0)
}

pub fn translate_box(b: &Box3D, offset: Vec3) -> Box3D {
    Box3D {
        min: [
            b.min[0] + offset[0],
            b.min[1] + offset[1],
            b.min[2] + offset[2],
        ],
        max: [
            b.max[0] + offset[0],
            b.max[1] + offset[1],
            b.max[2] + offset[2],
        ],
    }
}

pub fn expand_box(b: &Box3D, amount: Vec3) -> Box3D {
    Box3D {
        min: [
            b.min[0] - amount[0],
            b.min[1] - amount[1],
            b.min[2] - amount[2],
        ],
        max: [
            b.max[0] + amount[0],
            b.max[1] + amount[1],
            b.max[2] + amount[2],
        ],
    }
}

pub fn union_boxes(boxes: &[Box3D]) -> Box3D {
    let Some((first, rest)) = boxes.split_first() else {
        return Box3D {
            min: [0.0; 3],
            max: [0.0; 3],
        };
    };
    let mut result = *first;
    for b in rest {
        for axis in 0..3 {
            result.min[axis] = result.min[axis].min(b.min[axis]);
            result.max[axis] = result.max[axis].max(b.max[axis]);
        }
    }
    result
}

pub fn contains_box(container: &Box3D, object: &Box3D) -> bool {
    (0..3).all(|axis| {
        object.min[axis] >= container.min[axis] - EPSILON
            && object.max[axis] <= container.max[axis] + EPSILON
    })
}

pub fn boxes_intersect(a: &Box3D, b: &Box3D, clearance: f64) -> bool {
    (0..3)
        .all(|axis| a.min[axis] < b.max[axis] + clearance && a.max[axis] > b.min[axis] - clearance)
}

pub fn distance(a: Vec3, b: Vec3) -> f64 {
    let (dx, dy, dz) = (a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    (dx * dx + dy * dy + dz * dz).sqrt()
}

pub fn dimensions_to_vec3(dimensions: &Dimensions3D) -> Vec3 {
    [dimensions.length, dimensions.width, dimensions.height]
}

/// Sorted, de-duplicated coordinate list (the JS `Set` + numeric sort).
fn sorted_unique(mut values: Vec<f64>) -> Vec<f64> {
    values.sort_by(|a, b| a.total_cmp(b));
    values.dedup();
    values
}

pub fn largest_empty_axis_aligned_box(container: &Box3D, obstacles: &[Box3D]) -> LargestFreeBox {
    let clipped: Vec<&Box3D> = obstacles
        .iter()
        .filter(|obstacle| boxes_intersect(container, obstacle, 0.0))
        .collect();
    let coordinates: Vec<Vec<f64>> = (0..3)
        .map(|axis| {
            let mut values = vec![container.min[axis], container.max[axis]];
            for obstacle in &clipped {
                values.push(
                    obstacle.min[axis]
                        .min(container.max[axis])
                        .max(container.min[axis]),
                );
                values.push(
                    obstacle.max[axis]
                        .min(container.max[axis])
                        .max(container.min[axis]),
                );
            }
            sorted_unique(values)
        })
        .collect();

    let mut best = LargestFreeBox {
        box_: Box3D {
            min: container.min,
            max: container.min,
        },
        volume_mm3: 0.0,
    };
    let (xs, ys, zs) = (&coordinates[0], &coordinates[1], &coordinates[2]);
    for x0 in 0..xs.len() - 1 {
        for x1 in x0 + 1..xs.len() {
            for y0 in 0..ys.len() - 1 {
                for y1 in y0 + 1..ys.len() {
                    for z0 in 0..zs.len() - 1 {
                        for z1 in z0 + 1..zs.len() {
                            let candidate = Box3D {
                                min: [xs[x0], ys[y0], zs[z0]],
                                max: [xs[x1], ys[y1], zs[z1]],
                            };
                            let volume = box_volume(&candidate);
                            if volume <= best.volume_mm3 {
                                continue;
                            }
                            if clipped
                                .iter()
                                .any(|obstacle| boxes_intersect(&candidate, obstacle, 0.0))
                            {
                                continue;
                            }
                            best = LargestFreeBox {
                                box_: candidate,
                                volume_mm3: volume,
                            };
                        }
                    }
                }
            }
        }
    }
    best
}

pub fn clip_box_to_container(container: &Box3D, b: &Box3D) -> Option<Box3D> {
    let mut clipped = Box3D {
        min: [0.0; 3],
        max: [0.0; 3],
    };
    for axis in 0..3 {
        clipped.min[axis] = container.min[axis].max(b.min[axis]);
        clipped.max[axis] = container.max[axis].min(b.max[axis]);
        if clipped.max[axis] - clipped.min[axis] <= 0.0 {
            return None;
        }
    }
    Some(clipped)
}

/// Exact volume of the union of boxes clipped to the container.
pub fn union_volume_mm3(container: &Box3D, boxes: &[Box3D]) -> f64 {
    let clipped: Vec<Box3D> = boxes
        .iter()
        .filter_map(|b| clip_box_to_container(container, b))
        .collect();
    if clipped.is_empty() {
        return 0.0;
    }
    let coordinates: Vec<Vec<f64>> = (0..3)
        .map(|axis| {
            sorted_unique(
                clipped
                    .iter()
                    .flat_map(|b| [b.min[axis], b.max[axis]])
                    .collect(),
            )
        })
        .collect();
    let (xs, ys, zs) = (&coordinates[0], &coordinates[1], &coordinates[2]);
    let (nx, ny, nz) = (xs.len() - 1, ys.len() - 1, zs.len() - 1);
    let index_of = |values: &[f64], value: f64| values.partition_point(|v| *v < value);
    let mut occupied = vec![false; nx * ny * nz];
    for b in &clipped {
        let (x0, x1) = (index_of(xs, b.min[0]), index_of(xs, b.max[0]));
        let (y0, y1) = (index_of(ys, b.min[1]), index_of(ys, b.max[1]));
        let (z0, z1) = (index_of(zs, b.min[2]), index_of(zs, b.max[2]));
        for x in x0..x1 {
            for y in y0..y1 {
                for z in z0..z1 {
                    occupied[(x * ny + y) * nz + z] = true;
                }
            }
        }
    }
    let mut volume = 0.0;
    for x in 0..nx {
        let dx = xs[x + 1] - xs[x];
        for y in 0..ny {
            let area = dx * (ys[y + 1] - ys[y]);
            for z in 0..nz {
                if occupied[(x * ny + y) * nz + z] {
                    volume += area * (zs[z + 1] - zs[z]);
                }
            }
        }
    }
    volume
}

/* -------------------------------------------------------- enclosure depth */

/// Free depth under an axis-aligned footprint, measured from the lid.
pub fn available_depth_for_box(spec: &EnclosureSpec, object: &Box3D) -> f64 {
    let Some(enclosure) = spec.as_height_map() else {
        return spec.dimensions_mm().height;
    };
    let map = heightmap::map_for(enclosure);
    let margin = map.safety_margin_mm;
    let (Some((c0, c1)), Some((r0, r1))) = (
        map.column_window(object.min[0] - margin, object.max[0] + margin),
        map.row_window(object.min[1] - margin, object.max[1] + margin),
    ) else {
        return 0.0;
    };
    let mut minimum = u8::MAX;
    for row in r0..=r1 {
        minimum = minimum.min(map.row_range_min(row, c0, c1));
        if minimum == 0 {
            return 0.0;
        }
    }
    minimum as f64 * map.quantization_mm
}

/// A component's rotated rectangular footprint in the deck plane.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Footprint2D {
    pub center_x_mm: f64,
    pub center_y_mm: f64,
    pub half_length_mm: f64,
    pub half_width_mm: f64,
    pub angle_rad: f64,
}

impl Footprint2D {
    pub fn corners(&self) -> [[f64; 2]; 4] {
        let (sin, cos) = self.angle_rad.sin_cos();
        let mut corners = [[0.0; 2]; 4];
        let mut index = 0;
        for su in [-1.0, 1.0] {
            for sv in [-1.0, 1.0] {
                let u = su * self.half_length_mm;
                let v = sv * self.half_width_mm;
                corners[index] = [
                    self.center_x_mm + u * cos - v * sin,
                    self.center_y_mm + u * sin + v * cos,
                ];
                index += 1;
            }
        }
        corners
    }

    fn of_box(b: &Box3D) -> Self {
        Self {
            center_x_mm: (b.min[0] + b.max[0]) / 2.0,
            center_y_mm: (b.min[1] + b.max[1]) / 2.0,
            half_length_mm: (b.max[0] - b.min[0]) / 2.0,
            half_width_mm: (b.max[1] - b.min[1]) / 2.0,
            angle_rad: 0.0,
        }
    }
}

pub fn component_footprint(placement: &ComponentPlacement) -> Footprint2D {
    let tilt = placement.tilt_deg.to_radians();
    // The plan projection of a pitched box is still a rectangle: the length
    // shortens by cos(tilt) while the box height leans into the plan by sin.
    let half_length_mm = (placement.dimensions_mm.length / 2.0) * tilt.cos().abs()
        + (placement.dimensions_mm.height / 2.0) * tilt.sin().abs();
    Footprint2D {
        center_x_mm: placement.position[0],
        center_y_mm: placement.position[1],
        half_length_mm,
        half_width_mm: placement.dimensions_mm.width / 2.0,
        angle_rad: placement.rotation_deg.to_radians(),
    }
}

/// Separating-axis test for two rotated rectangles in the deck plane.
pub fn footprints_intersect(a: &Footprint2D, b: &Footprint2D) -> bool {
    let corners_a = a.corners();
    let corners_b = b.corners();
    let extent = |corners: &[[f64; 2]; 4], ax: f64, ay: f64| {
        corners
            .iter()
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), [x, y]| {
                let dot = x * ax + y * ay;
                (lo.min(dot), hi.max(dot))
            })
    };
    for shape in [a, b] {
        let (sin, cos) = shape.angle_rad.sin_cos();
        for [ax, ay] in [[cos, sin], [-sin, cos]] {
            let (min_a, max_a) = extent(&corners_a, ax, ay);
            let (min_b, max_b) = extent(&corners_b, ax, ay);
            if max_a <= min_b + EPSILON || max_b <= min_a + EPSILON {
                return false;
            }
        }
    }
    true
}

/// Free depth under a rotated footprint: minimum over the height-map cells
/// the rectangle actually covers, so a diagonal component is not penalised
/// for the corners of its axis-aligned bounding box.
pub fn available_depth_for_footprint(spec: &EnclosureSpec, footprint: &Footprint2D) -> f64 {
    let Some(enclosure) = spec.as_height_map() else {
        return spec.dimensions_mm().height;
    };
    let map = heightmap::map_for(enclosure);
    let margin = map.safety_margin_mm;
    let (sin, cos) = footprint.angle_rad.sin_cos();
    let reach_x =
        cos.abs() * footprint.half_length_mm + sin.abs() * footprint.half_width_mm + margin;
    let reach_y =
        sin.abs() * footprint.half_length_mm + cos.abs() * footprint.half_width_mm + margin;
    let (Some((c0, c1)), Some((r0, r1))) = (
        map.column_window(
            footprint.center_x_mm - reach_x,
            footprint.center_x_mm + reach_x,
        ),
        map.row_window(
            footprint.center_y_mm - reach_y,
            footprint.center_y_mm + reach_y,
        ),
    ) else {
        return 0.0;
    };
    let u_limit = footprint.half_length_mm + margin;
    let v_limit = footprint.half_width_mm + margin;
    let mut minimum = u8::MAX;
    for row in r0..=r1 {
        let y = map.origin[1] + row as f64 * map.step_mm - footprint.center_y_mm;
        for column in c0..=c1 {
            let x = map.origin[0] + column as f64 * map.step_mm - footprint.center_x_mm;
            let u = x * cos + y * sin;
            if !(-u_limit..=u_limit).contains(&u) {
                continue;
            }
            let v = -x * sin + y * cos;
            if !(-v_limit..=v_limit).contains(&v) {
                continue;
            }
            minimum = minimum.min(map.sample(row, column));
            if minimum == 0 {
                return 0.0;
            }
        }
    }
    minimum as f64 * map.quantization_mm
}

/// Lowest possible centre z of a (possibly pitched) component resting on the
/// enclosure floor: the inclined bottom face settles onto the height map like
/// a rigid plate. `INFINITY` when the face leaves the sampled grid or sits
/// over a wall.
pub fn settle_component_center_z(spec: &EnclosureSpec, placement: &ComponentPlacement) -> f64 {
    let Dimensions3D {
        length,
        width,
        height,
    } = placement.dimensions_mm;
    let (sin_t, cos_t) = placement.tilt_deg.to_radians().sin_cos();
    let Some(enclosure) = spec.as_height_map() else {
        return -spec.dimensions_mm().height / 2.0
            + (length / 2.0) * sin_t.abs()
            + (height / 2.0) * cos_t.abs();
    };
    let map = heightmap::map_for(enclosure);
    let margin = map.safety_margin_mm;
    let top_z = enclosure.top_z();
    let (sin_y, cos_y) = placement.rotation_deg.to_radians().sin_cos();
    // Plan centre of the bottom face: shifted opposite to the lean direction.
    let face_center_x = placement.position[0] - (height / 2.0) * sin_t * cos_y;
    let face_center_y = placement.position[1] - (height / 2.0) * sin_t * sin_y;
    let half_u = (length / 2.0) * cos_t.abs();
    let half_v = width / 2.0;
    let reach_x = cos_y.abs() * half_u + sin_y.abs() * half_v + margin;
    let reach_y = sin_y.abs() * half_u + cos_y.abs() * half_v + margin;
    let (Some((c0, c1)), Some((r0, r1))) = (
        map.column_window(face_center_x - reach_x, face_center_x + reach_x),
        map.row_window(face_center_y - reach_y, face_center_y + reach_y),
    ) else {
        return f64::INFINITY;
    };
    let cos_safe = cos_t.abs().max(1e-6);
    let mut min_center_z = f64::NEG_INFINITY;
    for row in r0..=r1 {
        let dy = map.origin[1] + row as f64 * map.step_mm - face_center_y;
        for column in c0..=c1 {
            let dx = map.origin[0] + column as f64 * map.step_mm - face_center_x;
            let u_plan = dx * cos_y + dy * sin_y;
            if u_plan.abs() > half_u + margin {
                continue;
            }
            let v = -dx * sin_y + dy * cos_y;
            if v.abs() > half_v + margin {
                continue;
            }
            let depth = map.sample(row, column);
            if depth == 0 {
                return f64::INFINITY;
            }
            let u = u_plan / cos_safe;
            let floor_z = top_z - depth as f64 * map.quantization_mm;
            min_center_z = min_center_z.max(floor_z + u * sin_t + (height / 2.0) * cos_t);
        }
    }
    if min_center_z.is_finite() {
        min_center_z
    } else {
        f64::INFINITY
    }
}

/// Vertical half-extent of a pitched component's bounding box.
pub fn component_half_height(placement: &ComponentPlacement) -> f64 {
    let (sin, cos) = placement.tilt_deg.to_radians().sin_cos();
    (placement.dimensions_mm.length / 2.0) * sin.abs()
        + (placement.dimensions_mm.height / 2.0) * cos.abs()
}

pub fn component_box(placement: &ComponentPlacement, enclosure: &EnclosureSpec) -> Box3D {
    let corners = component_footprint(placement).corners();
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for [x, y] in corners {
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
    }
    let half_height = component_half_height(placement);
    let center_z = settle_component_center_z(enclosure, placement);
    if !center_z.is_finite() {
        // Unplaceable spot (over a wall / outside the grid): park the box
        // above the lid so it reads as outside instead of aborting.
        let top_z = enclosure.dimensions_mm().height / 2.0;
        return Box3D {
            min: [min_x, min_y, top_z],
            max: [max_x, max_y, top_z + half_height * 2.0],
        };
    }
    Box3D {
        min: [min_x, min_y, center_z - half_height],
        max: [max_x, max_y, center_z + half_height],
    }
}

fn z_ranges_overlap(a: &Box3D, b: &Box3D) -> bool {
    a.min[2] < b.max[2] && a.max[2] > b.min[2]
}

/* ------------------------------------------------------------ containment */

/// Whether an axis-aligned box fits inside the enclosure (floor profile
/// included for height-map enclosures).
pub fn enclosure_contains(spec: &EnclosureSpec, object: &Box3D) -> bool {
    let container = enclosure_bounds(spec);
    if spec.as_height_map().is_none() {
        return contains_box(&container, object);
    }
    let top_z = container.max[2];
    let required_depth = top_z - object.min[2];
    object.max[2] <= top_z + EPSILON
        && object.min[2] >= container.min[2] - EPSILON
        && available_depth_for_box(spec, object) + EPSILON >= required_depth
}

/// Smallest gap between the box and the enclosure walls, floor and lid.
pub fn enclosure_clearance(spec: &EnclosureSpec, object: &Box3D) -> f64 {
    let container = enclosure_bounds(spec);
    let floor_z = if spec.as_height_map().is_some() {
        container.max[2] - available_depth_for_box(spec, object)
    } else {
        container.min[2]
    };
    [
        object.min[0] - container.min[0],
        container.max[0] - object.max[0],
        object.min[1] - container.min[1],
        container.max[1] - object.max[1],
        object.min[2] - floor_z,
        container.max[2] - object.max[2],
    ]
    .into_iter()
    .fold(f64::INFINITY, f64::min)
}

/// Usable inner volume of the enclosure.
pub fn enclosure_volume(spec: &EnclosureSpec) -> f64 {
    match spec.as_height_map() {
        Some(enclosure) => heightmap::map_for(enclosure).usable_volume_mm3,
        None => {
            let Dimensions3D {
                length,
                width,
                height,
            } = *spec.dimensions_mm();
            length * width * height
        }
    }
}

/* ------------------------------------------------------------- evaluation */

/// Pack envelopes and service volumes a component must not intersect.
pub fn pack_obstacles(plan: &PackPlan) -> Vec<Box3D> {
    plan.blocks
        .iter()
        .map(|block| block.envelope)
        .chain(plan.service_volumes.iter().map(|volume| volume.box_))
        .collect()
}

/// Whether a placement is inside the enclosure and clear of the pack and of
/// `others`. The height map must already be compiled (see
/// [`heightmap::ensure_compiled`]).
pub fn component_fits(
    enclosure: &EnclosureSpec,
    pack_obstacles: &[Box3D],
    others: &[ComponentPlacement],
    candidate: &ComponentPlacement,
) -> bool {
    let container = enclosure_bounds(enclosure);
    let b = component_box(candidate, enclosure);
    let outside = if enclosure.as_height_map().is_some() {
        b.max[2] > container.max[2] + EPSILON
            || b.min[0] < container.min[0] - EPSILON
            || b.max[0] > container.max[0] + EPSILON
            || b.min[1] < container.min[1] - EPSILON
            || b.max[1] > container.max[1] + EPSILON
    } else {
        !contains_box(&container, &b)
    };
    if outside {
        return false;
    }
    let footprint = component_footprint(candidate);
    if pack_obstacles.iter().any(|obstacle| {
        z_ranges_overlap(&b, obstacle)
            && footprints_intersect(&footprint, &Footprint2D::of_box(obstacle))
    }) {
        return false;
    }
    !others.iter().any(|other| {
        let other_box = component_box(other, enclosure);
        z_ranges_overlap(&b, &other_box)
            && footprints_intersect(&footprint, &component_footprint(other))
    })
}

pub fn evaluate_workspace(
    enclosure: &EnclosureSpec,
    plan: &PackPlan,
    components: &[ComponentPlacement],
) -> Result<WorkspaceEvaluation, HeightMapError> {
    heightmap::ensure_compiled(enclosure)?;
    let profiled = enclosure.as_height_map().is_some();
    let container = enclosure_bounds(enclosure);
    let pack_obstacles: Vec<Box3D> = plan
        .blocks
        .iter()
        .map(|block| block.envelope)
        .chain(plan.service_volumes.iter().map(|volume| volume.box_))
        .collect();
    let footprints: Vec<Footprint2D> = components.iter().map(component_footprint).collect();
    let boxes: Vec<Box3D> = components
        .iter()
        .map(|placement| component_box(placement, enclosure))
        .collect();
    let top_z = container.max[2];

    let evaluated: Vec<ComponentEvaluation> = components
        .iter()
        .enumerate()
        .map(|(index, component)| {
            let b = &boxes[index];
            let footprint = &footprints[index];
            let collides_pack = pack_obstacles.iter().any(|obstacle| {
                z_ranges_overlap(b, obstacle)
                    && footprints_intersect(footprint, &Footprint2D::of_box(obstacle))
            });
            let collides_component = footprints.iter().enumerate().any(|(other_index, other)| {
                other_index != index
                    && z_ranges_overlap(b, &boxes[other_index])
                    && footprints_intersect(footprint, other)
            });
            // `component_box` already settles the (possibly pitched) part onto
            // the floor or parks it above the lid when unplaceable, so the lid
            // plane and the plan bounds are all that is left to verify.
            let outside = if profiled {
                b.max[2] > top_z + EPSILON
                    || b.min[0] < container.min[0] - EPSILON
                    || b.max[0] > container.max[0] + EPSILON
                    || b.min[1] < container.min[1] - EPSILON
                    || b.max[1] > container.max[1] + EPSILON
            } else {
                !contains_box(&container, b)
            };
            ComponentEvaluation {
                id: component.id.clone(),
                box_: *b,
                collides: collides_pack || collides_component,
                outside,
            }
        })
        .collect();

    let all_obstacles: Vec<Box3D> = pack_obstacles.iter().chain(&boxes).copied().collect();
    let enclosure_volume = enclosure_volume(enclosure);
    let occupied_volume = union_volume_mm3(&container, &all_obstacles);
    let free_volume_mm3 = (enclosure_volume - occupied_volume).max(0.0);
    // The largest free box is only meaningful for a rectangular enclosure; the
    // profiled case is validated through the height map instead.
    let largest_free_box = if profiled {
        LargestFreeBox {
            box_: box_from_center_size([0.0; 3], [0.0; 3]),
            volume_mm3: 0.0,
        }
    } else {
        largest_empty_axis_aligned_box(&container, &all_obstacles)
    };
    Ok(WorkspaceEvaluation {
        has_collision: evaluated.iter().any(|item| item.collides || item.outside),
        components: evaluated,
        free_volume_mm3,
        free_percent: (free_volume_mm3 / enclosure_volume) * 100.0,
        largest_free_box,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::heightmap::test_support::register_ramp;

    #[test]
    fn touching_faces_do_not_overlap() {
        let left = box_from_center_size([-5.0, 0.0, 0.0], [10.0; 3]);
        let right = box_from_center_size([5.0, 0.0, 0.0], [10.0; 3]);
        assert!(!boxes_intersect(&left, &right, 0.0));
    }

    #[test]
    fn finds_the_empty_region_around_an_obstacle() {
        let container = box_from_center_size([0.0; 3], [100.0, 40.0, 20.0]);
        let obstacle = box_from_center_size([-25.0, 0.0, 0.0], [50.0, 40.0, 20.0]);
        let free = largest_empty_axis_aligned_box(&container, &[obstacle]);
        assert_eq!(free.volume_mm3, 50.0 * 40.0 * 20.0);
    }

    #[test]
    fn diagonal_footprint_passes_where_its_box_collides() {
        let diagonal = Footprint2D {
            center_x_mm: 30.0,
            center_y_mm: 30.0,
            half_length_mm: 30.0,
            half_width_mm: 10.0,
            angle_rad: std::f64::consts::FRAC_PI_4,
        };
        let block = Footprint2D {
            center_x_mm: 45.0,
            center_y_mm: 5.0,
            half_length_mm: 10.0,
            half_width_mm: 10.0,
            angle_rad: 0.0,
        };
        assert!(boxes_intersect(
            &box_from_center_size([30.0, 30.0, 0.0], [57.0, 57.0, 10.0]),
            &box_from_center_size([45.0, 5.0, 0.0], [20.0, 20.0, 10.0]),
            0.0,
        ));
        assert!(!footprints_intersect(&diagonal, &block));
        let crossing = Footprint2D {
            center_x_mm: 30.0,
            center_y_mm: 25.0,
            ..block
        };
        assert!(footprints_intersect(&diagonal, &crossing));
    }

    fn plate(tilt_deg: f64) -> ComponentPlacement {
        ComponentPlacement {
            id: "plate".into(),
            component_id: "custom".into(),
            position: [2.0, 0.0],
            rotation_deg: 0.0,
            tilt_deg,
            dimensions_mm: Dimensions3D {
                length: 20.0,
                width: 10.0,
                height: 4.0,
            },
        }
    }

    #[test]
    fn pitched_component_settles_onto_the_ramp() {
        let spec = register_ramp();
        let flat = settle_component_center_z(&spec, &plate(0.0));
        // The test ramp rises toward +x, so the plate lies along it nose-up.
        let pitched = settle_component_center_z(&spec, &plate(-50.0));
        assert!(flat.is_finite() && pitched.is_finite());
        assert!(pitched < flat);
        let box_spec = EnclosureSpec::Box {
            dimensions_mm: Dimensions3D {
                length: 100.0,
                width: 50.0,
                height: 30.0,
            },
        };
        assert!((settle_component_center_z(&box_spec, &plate(0.0)) - (-15.0 + 2.0)).abs() < 1e-9);
        assert!((settle_component_center_z(&box_spec, &plate(90.0)) - (-15.0 + 10.0)).abs() < 1e-9);
    }

    #[test]
    fn rotated_component_rests_on_its_true_footprint() {
        let spec = register_ramp();
        let footprint = Footprint2D {
            center_x_mm: -14.0,
            center_y_mm: 0.0,
            half_length_mm: 14.0,
            half_width_mm: 5.0,
            angle_rad: std::f64::consts::FRAC_PI_4,
        };
        assert_eq!(available_depth_for_footprint(&spec, &footprint), 46.0);
        let over_ramp = Footprint2D {
            center_x_mm: 2.0,
            ..footprint
        };
        assert!(available_depth_for_footprint(&spec, &over_ramp) < 46.0);
    }

    #[test]
    fn union_volume_neither_double_counts_nor_leaks_outside() {
        let container = box_from_center_size([0.0; 3], [100.0; 3]);
        let b = box_from_center_size([0.0; 3], [10.0; 3]);
        assert!((union_volume_mm3(&container, &[b, b]) - 1000.0).abs() < 1e-9);
        let outside = box_from_center_size([1000.0, 0.0, 0.0], [10.0; 3]);
        let straddling = box_from_center_size([50.0, 0.0, 0.0], [10.0; 3]);
        assert_eq!(union_volume_mm3(&container, &[outside]), 0.0);
        assert!((union_volume_mm3(&container, &[straddling]) - 500.0).abs() < 1e-9);
    }
}
