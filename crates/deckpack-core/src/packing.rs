//! Exhaustive enumeration of pack layouts.
//!
//! For every cell orientation, lattice (brick or staggered), stagger axis
//! and factorisation of the parallel and series counts, the lattice is built
//! locally, routed into one electrical S-chain, wrapped with the tolerance
//! layers and service volumes, and then placed into the enclosure: three
//! anchors for a box, or draped over the sampled floor for a profiled case.

use std::collections::HashMap;

use rayon::prelude::*;

use crate::geometry::{
    self, EPSILON, box_from_center_size, box_size, box_volume, enclosure_bounds, expand_box,
    largest_empty_axis_aligned_box, union_boxes,
};
use crate::heightmap::{self, HeightMapEnclosure, HeightMapError, ProfileCylinder};
use crate::jsmath;
use crate::service::active_service_reservations;
use crate::types::*;

const ANCHORS: [PlacementAnchor; 3] = [
    PlacementAnchor::Tail,
    PlacementAnchor::Center,
    PlacementAnchor::Nose,
];
const PROFILE_PLACEMENT_STEP_MM: f64 = 2.0;
const SLIDE_STEP_MM: f64 = 0.25;
const SLIDE_MAX_MM: f64 = 30.0;
const ROUTE_ORDERS: [[usize; 3]; 6] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
];

#[derive(Clone, Copy, Debug)]
struct CompiledTolerances {
    radial: f64,
    axial_per_end: f64,
    /// Between any two touching cells (compound).
    between_cells: f64,
    /// Between neighbours of one row / brick grid only (holder wall).
    between_columns: f64,
    /// Between nested cells of adjacent staggered rows only (spacer web).
    between_rows: f64,
    /// Extra vertical lift of every staggered row.
    between_layers: f64,
    between_groups: f64,
    outer_wrap: f64,
    /// Lift of the whole pack above the enclosure floor (holder base).
    floor: f64,
}

impl CompiledTolerances {
    /// Centre-to-centre gap between neighbours along a row or brick grid.
    fn lattice_gap(&self) -> f64 {
        self.between_cells + self.between_columns
    }

    /// Centre-to-centre gap between nested cells of adjacent staggered rows.
    fn nesting_gap(&self) -> f64 {
        self.between_cells + self.between_rows
    }

    /// Row pitch of a staggered lattice: the upper cell sits half a lateral
    /// pitch aside and at the nesting contact distance from both lower
    /// neighbours, plus any explicit layer lift. With equal lattice and
    /// nesting gaps this is the hex pitch·√3/2.
    fn stagger_row_pitch(&self, reservation_diameter: f64, lateral_pitch: f64) -> f64 {
        let contact = reservation_diameter + self.nesting_gap();
        let half = lateral_pitch / 2.0;
        (contact * contact - half * half).max(0.0).sqrt() + self.between_layers
    }
}

pub fn sum_tolerance(stack: &[ToleranceLayer], application: ToleranceApplication) -> f64 {
    stack
        .iter()
        .filter(|layer| layer.application == application)
        .fold(0.0, |sum, layer| sum + layer.thickness_mm.max(0.0))
}

fn compile_tolerances(stack: &[ToleranceLayer]) -> CompiledTolerances {
    CompiledTolerances {
        radial: sum_tolerance(stack, ToleranceApplication::Radial),
        axial_per_end: sum_tolerance(stack, ToleranceApplication::AxialEnds),
        between_cells: sum_tolerance(stack, ToleranceApplication::BetweenCells),
        between_columns: sum_tolerance(stack, ToleranceApplication::BetweenColumns),
        between_rows: sum_tolerance(stack, ToleranceApplication::BetweenRows),
        between_layers: sum_tolerance(stack, ToleranceApplication::BetweenLayers),
        between_groups: sum_tolerance(stack, ToleranceApplication::BetweenGroups),
        outer_wrap: sum_tolerance(stack, ToleranceApplication::AllFaces),
        floor: sum_tolerance(stack, ToleranceApplication::Floor),
    }
}

/// Every ordered integer factorisation `x × y × z = value`.
pub fn factor_triples(value: u32) -> Vec<Grid3> {
    let mut result = Vec::new();
    for x in 1..=value {
        if !value.is_multiple_of(x) {
            continue;
        }
        let remaining = value / x;
        for y in 1..=remaining {
            if !remaining.is_multiple_of(y) {
                continue;
            }
            result.push([x, y, remaining / y]);
        }
    }
    result
}

fn cell_size_for_orientation(orientation: Axis, diameter: f64, height: f64) -> Vec3 {
    let mut size = [diameter; 3];
    size[orientation.index()] = height;
    size
}

#[derive(Clone, Debug)]
struct GroupTemplate {
    centers: Vec<Vec3>,
    reservation_size: Vec3,
    /// Single-cell reservation: sleeved cell plus radial / axial tolerance layers.
    reservation_cell_size: Vec3,
    /// Centre-to-centre pitch inside a group (reservation plus compound gap).
    cell_pitch: Vec3,
}

fn make_group_template(
    factors: Grid3,
    actual_cell_size: Vec3,
    orientation: Axis,
    mode: PackingMode,
    stagger_row_axis: Option<Axis>,
    tolerances: &CompiledTolerances,
) -> GroupTemplate {
    let axial = orientation.index();
    let mut reservation_cell_size = [0.0; 3];
    for axis in 0..3 {
        reservation_cell_size[axis] = if axis == axial {
            actual_cell_size[axis] + tolerances.axial_per_end * 2.0
        } else {
            actual_cell_size[axis] + tolerances.radial * 2.0
        };
    }
    let pitch = reservation_cell_size.map(|value| value + tolerances.lattice_gap());
    let row_axis = stagger_row_axis.map(Axis::index);
    let shift_axis = (0..3).find(|axis| *axis != axial && Some(*axis) != row_axis);
    let row_pitch = match (row_axis, shift_axis) {
        (Some(row), Some(shift)) => {
            tolerances.stagger_row_pitch(reservation_cell_size[row], pitch[shift])
        }
        _ => 0.0,
    };

    let mut centers = Vec::new();
    for x in 0..factors[0] {
        for y in 0..factors[1] {
            for z in 0..factors[2] {
                let grid = [x as f64, y as f64, z as f64];
                let mut position = [grid[0] * pitch[0], grid[1] * pitch[1], grid[2] * pitch[2]];
                if let (PackingMode::Staggered, Some(row), Some(shift)) =
                    (mode, row_axis, shift_axis)
                {
                    position[row] = grid[row] * row_pitch;
                    position[shift] += (grid[row] % 2.0) * pitch[shift] * 0.5;
                }
                centers.push(position);
            }
        }
    }

    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for center in &centers {
        for axis in 0..3 {
            min[axis] = min[axis].min(center[axis] - reservation_cell_size[axis] / 2.0);
            max[axis] = max[axis].max(center[axis] + reservation_cell_size[axis] / 2.0);
        }
    }
    for center in &mut centers {
        for axis in 0..3 {
            center[axis] -= min[axis];
        }
    }
    GroupTemplate {
        centers,
        reservation_size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
        reservation_cell_size,
        cell_pitch: pitch,
    }
}

#[derive(Clone, Copy, Debug)]
struct CrossGroupStagger {
    row_axis: usize,
    shift_axis: usize,
    row_pitch_mm: f64,
    shift_mm: f64,
}

#[derive(Clone, Debug)]
struct LocalGroup {
    id: String,
    grid: Grid3,
    center: Vec3,
    cell_positions: Vec<Vec3>,
}

fn create_local_groups(
    series_factors: Grid3,
    template: &GroupTemplate,
    between_groups: f64,
    stagger: Option<CrossGroupStagger>,
) -> Vec<LocalGroup> {
    let pitch = template
        .reservation_size
        .map(|value| value + between_groups);
    let mut groups = Vec::new();
    for x in 0..series_factors[0] {
        for y in 0..series_factors[1] {
            for z in 0..series_factors[2] {
                let grid = [x, y, z];
                let mut origin = [
                    x as f64 * pitch[0],
                    y as f64 * pitch[1],
                    z as f64 * pitch[2],
                ];
                if let Some(stagger) = stagger {
                    // Nest single-cell-thick group rows like a hex lattice:
                    // compressed row pitch, odd rows shifted half a cell pitch.
                    let row_index = grid[stagger.row_axis];
                    origin[stagger.row_axis] = row_index as f64 * stagger.row_pitch_mm;
                    origin[stagger.shift_axis] += (row_index % 2) as f64 * stagger.shift_mm;
                }
                let cell_positions: Vec<Vec3> = template
                    .centers
                    .iter()
                    .map(|center| {
                        [
                            center[0] + origin[0],
                            center[1] + origin[1],
                            center[2] + origin[2],
                        ]
                    })
                    .collect();
                let count = cell_positions.len() as f64;
                let sum = cell_positions.iter().fold([0.0; 3], |sum, p| {
                    [sum[0] + p[0], sum[1] + p[1], sum[2] + p[2]]
                });
                groups.push(LocalGroup {
                    id: format!("g-{x}-{y}-{z}"),
                    grid,
                    center: sum.map(|value| value / count),
                    cell_positions,
                });
            }
        }
    }
    groups
}

fn serpentine_coordinates(dimensions: Grid3, order: [usize; 3]) -> Vec<Grid3> {
    fn recurse(dimensions: Grid3, order: [usize; 3], depth: usize) -> Vec<Grid3> {
        let axis = order[depth];
        if depth == order.len() - 1 {
            return (0..dimensions[axis])
                .map(|value| {
                    let mut coordinate = [0; 3];
                    coordinate[axis] = value;
                    coordinate
                })
                .collect();
        }
        let inner = recurse(dimensions, order, depth + 1);
        let mut result = Vec::new();
        for value in 0..dimensions[axis] {
            let path: Vec<Grid3> = if value % 2 == 0 {
                inner.clone()
            } else {
                inner.iter().rev().copied().collect()
            };
            for mut coordinate in path {
                coordinate[axis] = value;
                result.push(coordinate);
            }
        }
        result
    }
    recurse(dimensions, order, 0)
}

/// Serpentine order over the group grid with the shortest S-chain.
fn route_groups(groups: &[LocalGroup], dimensions: Grid3) -> Vec<usize> {
    let by_grid: HashMap<Grid3, usize> = groups
        .iter()
        .enumerate()
        .map(|(i, g)| (g.grid, i))
        .collect();
    let mut best: Vec<usize> = (0..groups.len()).collect();
    let mut best_length = f64::INFINITY;
    for order in ROUTE_ORDERS {
        let route: Vec<usize> = serpentine_coordinates(dimensions, order)
            .iter()
            .map(|c| by_grid[c])
            .collect();
        let length = route.windows(2).fold(0.0, |sum, pair| {
            sum + distance(groups[pair[0]].center, groups[pair[1]].center)
        });
        if length < best_length {
            best = route;
            best_length = length;
        }
    }
    best
}

fn distance(a: Vec3, b: Vec3) -> f64 {
    jsmath::hypot(&[a[0] - b[0], a[1] - b[1], a[2] - b[2]])
}

fn service_box_for_envelope(reservation: &ServiceReservation, envelope: &Box3D) -> Box3D {
    let mut center = geometry::box_center(envelope);
    let face_axis = reservation.face.axis().index();
    let tangent = if face_axis == 0 { 1 } else { 0 };
    center[face_axis] = if reservation.face.sign() > 0.0 {
        envelope.max[face_axis] + reservation.size_mm[face_axis] / 2.0
    } else {
        envelope.min[face_axis] - reservation.size_mm[face_axis] / 2.0
    };
    let offset = reservation.offset_mm.unwrap_or([0.0; 3]);
    let face_length = envelope.max[tangent] - envelope.min[tangent];
    let tangent_limit = ((face_length - reservation.size_mm[tangent]) / 2.0).max(0.0);
    center[tangent] += offset[tangent].min(tangent_limit).max(-tangent_limit);
    box_from_center_size(center, reservation.size_mm)
}

fn anchor_offset(bounds: &Box3D, enclosure: &Box3D, anchor: PlacementAnchor) -> Vec3 {
    let bounds_center_y = (bounds.min[1] + bounds.max[1]) / 2.0;
    let x = match anchor {
        PlacementAnchor::Tail => enclosure.min[0] - bounds.min[0],
        PlacementAnchor::Nose => enclosure.max[0] - bounds.max[0],
        _ => -(bounds.min[0] + bounds.max[0]) / 2.0,
    };
    [x, -bounds_center_y, enclosure.min[2] - bounds.min[2]]
}

/* ---------------------------------------------------- profile placements */

struct ProfilePlacementRequest<'a> {
    enclosure: HeightMapEnclosure<'a>,
    container: &'a Box3D,
    local_bounds: &'a Box3D,
    local_cells: &'a [Vec3],
    /// Lattice layer of every local cell.
    cell_layers: &'a [u32],
    /// Centre distance at which two cells of adjacent layers touch.
    support_distance_mm: f64,
    /// Settle the lattice as one rigid body instead of draping columns. Brick
    /// packs stack cells vertically, so a column riding a ramp would push its
    /// whole tower up; only staggered lattices benefit from per-column settling.
    rigid: bool,
    axial_index: usize,
    orientation: Axis,
    cylinder_radius_mm: f64,
    cylinder_half_length_mm: f64,
    /// Holder base under the cells.
    floor_mm: f64,
}

#[derive(Clone, Debug)]
struct ProfilePlacement {
    anchor: PlacementAnchor,
    x_offset: f64,
    y_offset: f64,
    /// Final z of every local cell: the lattice drapes over the terrain.
    cell_z: Vec<f64>,
    /// Per-cell x adjustment: an edge column that would push its upper
    /// neighbours up instead slides outward along the ramp until it clears.
    cell_dx: Vec<f64>,
}

#[derive(Clone, Copy, Debug)]
struct Support {
    lower: usize,
    rise_mm: f64,
    lateral_mm: f64,
    touch_mm: f64,
}

struct Candidate {
    x: f64,
    cell_z: Vec<f64>,
    rest_mm: f64,
}

struct Draper<'a> {
    request: &'a ProfilePlacementRequest<'a>,
    y_offset: f64,
    layer_count: usize,
    by_layer: Vec<Vec<usize>>,
    supports: Vec<Vec<Support>>,
    top_limit_z: f64,
    near_misses: Vec<(f64, f64)>,
    near_miss_x: Option<f64>,
    near_miss_overflow: f64,
}

impl Draper<'_> {
    fn cylinder(&self, x: f64, y: f64) -> ProfileCylinder {
        ProfileCylinder {
            center_x_mm: x,
            center_y_mm: y,
            axis: self.request.orientation,
            radius_mm: self.request.cylinder_radius_mm,
            half_length_mm: self.request.cylinder_half_length_mm,
        }
    }

    fn own_floor(&self, index: usize, x: f64, shift_mm: f64) -> f64 {
        let cell = self.request.local_cells[index];
        heightmap::min_cylinder_center_z(
            self.request.enclosure,
            &self.cylinder(cell[0] + x + shift_mm, cell[1] + self.y_offset),
        ) + self.request.floor_mm
    }

    /// Drape (or rigidly settle) the lattice at one x offset.
    fn evaluate(&mut self, x: f64) -> Option<Candidate> {
        let cells = self.request.local_cells;
        let mut cell_z = vec![f64::NEG_INFINITY; cells.len()];
        let mut highest = f64::NEG_INFINITY;
        if self.request.rigid {
            let mut lift_mm = f64::NEG_INFINITY;
            for (index, cell) in cells.iter().enumerate() {
                let floor_z = self.own_floor(index, x, 0.0);
                if !floor_z.is_finite() {
                    return None;
                }
                lift_mm = lift_mm.max(floor_z - cell[2]);
            }
            for (index, cell) in cells.iter().enumerate() {
                cell_z[index] = cell[2] + lift_mm;
                highest = highest.max(cell_z[index]);
            }
        } else {
            for layer in 0..self.layer_count {
                for &index in &self.by_layer[layer] {
                    let floor_z = self.own_floor(index, x, 0.0);
                    if !floor_z.is_finite() {
                        return None;
                    }
                    let mut z = floor_z;
                    for support in &self.supports[index] {
                        z = z.max(cell_z[support.lower] + support.rise_mm);
                    }
                    cell_z[index] = z;
                    highest = highest.max(z);
                }
            }
        }
        let overflow = highest - self.top_limit_z;
        if overflow > EPSILON {
            // Remember the least-bad spots: feasibility windows narrower than
            // the scan step hide between grid points and are recovered by
            // refining.
            self.near_misses.push((x, overflow));
            if overflow < self.near_miss_overflow {
                self.near_miss_overflow = overflow;
                self.near_miss_x = Some(x);
            }
            return None;
        }
        let bottom = &self.by_layer[0];
        let rest_mm =
            bottom.iter().map(|&index| cell_z[index]).sum::<f64>() / (bottom.len().max(1) as f64);
        Some(Candidate { x, cell_z, rest_mm })
    }

    /// A bottom edge column pushed up by a ramp may instead slide outward
    /// along it: once its lateral distance to the upper row reaches the
    /// lattice touch distance the upper cells stay down, something the greedy
    /// drape cannot express. Only lattices whose stagger step runs along the
    /// deck can relax this way (a cylinder sliding along its own axis never
    /// clears its neighbours), and only when every affected upper cell keeps
    /// another support to rest on.
    fn slide_edge_columns(&self, x: f64, base_z: &[f64]) -> (Vec<f64>, Vec<f64>) {
        let cells = self.request.local_cells;
        let mut dx = vec![0.0; cells.len()];
        if self.request.rigid || self.request.axial_index == 0 || self.layer_count < 2 {
            return (base_z.to_vec(), dx);
        }
        let mut cell_z = base_z.to_vec();
        let bottom = &self.by_layer[0];
        for dir in [-1.0, 1.0] {
            let edge_x = bottom.iter().map(|&index| cells[index][0]).fold(
                if dir < 0.0 {
                    f64::INFINITY
                } else {
                    f64::NEG_INFINITY
                },
                |acc, v| {
                    if dir < 0.0 { acc.min(v) } else { acc.max(v) }
                },
            );
            let column: Vec<usize> = bottom
                .iter()
                .copied()
                .filter(|&index| (cells[index][0] - edge_x).abs() < 1e-6)
                .collect();
            let in_column = |index: usize| column.contains(&index);
            let mut dependents: Vec<(usize, Support)> = Vec::new();
            for &upper in &self.by_layer[1] {
                for pair in &self.supports[upper] {
                    if in_column(pair.lower) {
                        dependents.push((upper, *pair));
                    }
                }
            }
            if dependents.is_empty() {
                continue;
            }
            // An upper cell whose only support is the sliding column would
            // drop into the vacated groove; keep the plain lift for that shape.
            if dependents
                .iter()
                .any(|(upper, _)| self.supports[*upper].len() < 2)
            {
                continue;
            }
            let mut upper_base: Vec<(usize, f64)> = Vec::new();
            for (upper, _) in &dependents {
                if upper_base.iter().any(|(u, _)| u == upper) {
                    continue;
                }
                let mut base = self.own_floor(*upper, x, 0.0);
                for pair in &self.supports[*upper] {
                    if !in_column(pair.lower) {
                        base = base.max(cell_z[pair.lower] + pair.rise_mm);
                    }
                }
                if !base.is_finite() {
                    return (base_z.to_vec(), dx);
                }
                upper_base.push((*upper, base));
            }
            let base_of = |upper: usize| {
                upper_base
                    .iter()
                    .find(|(u, _)| *u == upper)
                    .map(|(_, b)| *b)
            };
            let pushes = dependents.iter().any(|(upper, _)| {
                cell_z[*upper] > base_of(*upper).unwrap_or(f64::INFINITY) + EPSILON
            });
            if !pushes {
                continue;
            }
            let mut shift = SLIDE_STEP_MM;
            'search: while shift <= SLIDE_MAX_MM + EPSILON {
                let mut slid_z: Vec<(usize, f64)> = Vec::with_capacity(column.len());
                for &index in &column {
                    let floor_z = self.own_floor(index, x, dir * shift);
                    if !floor_z.is_finite() || floor_z > self.top_limit_z {
                        break 'search;
                    }
                    slid_z.push((index, floor_z));
                }
                let slid_of = |index: usize| {
                    slid_z
                        .iter()
                        .find(|(i, _)| *i == index)
                        .map(|(_, z)| *z)
                        .unwrap_or(f64::NEG_INFINITY)
                };
                let clears = dependents.iter().all(|(upper, pair)| {
                    let lateral = pair.lateral_mm + shift;
                    if lateral >= pair.touch_mm {
                        return true;
                    }
                    let rise = (pair.touch_mm * pair.touch_mm - lateral * lateral).sqrt();
                    slid_of(pair.lower) + rise
                        <= base_of(*upper).unwrap_or(f64::NEG_INFINITY) + EPSILON
                });
                if clears {
                    for (index, z) in &slid_z {
                        dx[*index] = dir * shift;
                        cell_z[*index] = *z;
                    }
                    for (upper, base) in &upper_base {
                        cell_z[*upper] = *base;
                    }
                    break;
                }
                shift += SLIDE_STEP_MM;
            }
        }
        (cell_z, dx)
    }
}

/// Coarse scan grid along the deck: both extreme offsets, the centred one
/// when it lies between them, and every `PROFILE_PLACEMENT_STEP_MM` in between.
fn scan_offsets(tail_x: f64, nose_x: f64) -> Vec<f64> {
    let mut x_offsets = vec![tail_x, nose_x];
    if tail_x < 0.0 && nose_x > 0.0 {
        x_offsets.push(0.0);
    }
    let mut x = tail_x;
    while x <= nose_x + EPSILON {
        x_offsets.push(nose_x.min(x));
        x += PROFILE_PLACEMENT_STEP_MM;
    }
    x_offsets.sort_by(f64::total_cmp);
    x_offsets.dedup();
    x_offsets
}

/// Support pairs from the undraped lattice: an upper cell keeps at least its
/// original vertical spacing to every lower neighbour it actually rests on,
/// i.e. pairs at lattice touch distance, not farther diagonals.
fn support_pairs(
    request: &ProfilePlacementRequest<'_>,
    by_layer: &[Vec<usize>],
) -> Vec<Vec<Support>> {
    let cells = request.local_cells;
    let axial = request.axial_index;
    let lateral_index = if axial == 0 { 1 } else { 0 };
    let mut supports: Vec<Vec<Support>> = vec![Vec::new(); cells.len()];
    for layer in 1..by_layer.len() {
        for &upper in &by_layer[layer] {
            for &lower in &by_layer[layer - 1] {
                if (cells[upper][axial] - cells[lower][axial]).abs() > 1.0 {
                    continue;
                }
                let lateral = (cells[upper][lateral_index] - cells[lower][lateral_index]).abs();
                let rise = cells[upper][2] - cells[lower][2];
                let touch = jsmath::hypot(&[lateral, rise]);
                if touch > request.support_distance_mm {
                    continue;
                }
                supports[upper].push(Support {
                    lower,
                    rise_mm: rise,
                    lateral_mm: lateral,
                    touch_mm: touch,
                });
            }
        }
    }
    supports
}

impl Draper<'_> {
    /// Evaluate `x` only strictly inside the feasible offset range; the ends
    /// themselves are always part of the coarse grid.
    fn evaluate_inside(&mut self, x: f64, tail_x: f64, nose_x: f64, feasible: &mut Vec<Candidate>) {
        if x > tail_x
            && x < nose_x
            && let Some(candidate) = self.evaluate(x)
        {
            feasible.push(candidate);
        }
    }

    /// Feasibility windows narrower than the scan step hide between grid
    /// points. The overflow landscape can have several local minima (one per
    /// ramp), so zoom into the best few coarse near-misses, then once more,
    /// finer, around the single best spot.
    fn refine_near_misses(&mut self, tail_x: f64, nose_x: f64, feasible: &mut Vec<Candidate>) {
        let mut seeds = self.near_misses.clone();
        seeds.sort_by(|a, b| a.1.total_cmp(&b.1));
        let seeds: Vec<f64> = seeds.iter().take(4).map(|(x, _)| *x).collect();
        for seed in seeds {
            let mut x = seed - PROFILE_PLACEMENT_STEP_MM;
            while x <= seed + PROFILE_PLACEMENT_STEP_MM {
                self.evaluate_inside(x, tail_x, nose_x, feasible);
                x += 0.25;
            }
        }
        if feasible.is_empty()
            && let Some(near_miss_x) = self.near_miss_x
        {
            let mut x = near_miss_x - 0.3;
            while x <= near_miss_x + 0.3 + EPSILON {
                self.evaluate_inside(x, tail_x, nose_x, feasible);
                x += 0.03;
            }
        }
    }

    /// Refine around the deepest coarse hit so the pack truly rests on the
    /// floor instead of stopping at the scan grid resolution.
    fn refine_deepest(&mut self, tail_x: f64, nose_x: f64, feasible: &mut Vec<Candidate>) {
        let deepest_x = feasible
            .iter()
            .fold(None::<&Candidate>, |best, c| match best {
                Some(b) if c.rest_mm >= b.rest_mm => Some(b),
                _ => Some(c),
            })
            .expect("refine_deepest needs a feasible candidate")
            .x;
        let mut x = deepest_x - PROFILE_PLACEMENT_STEP_MM + 0.5;
        while x < deepest_x + PROFILE_PLACEMENT_STEP_MM {
            self.evaluate_inside(x, tail_x, nose_x, feasible);
            x += 0.5;
        }
    }
}

/// Representative offsets of a sorted feasible set: the deepest, the one
/// closest to the deck centre, the nose-most and the tail-most. When two
/// coincide the later label wins, so an extreme that is also the deepest is
/// reported as tail or nose.
fn pick_representatives(feasible: &[Candidate]) -> Vec<(f64, PlacementAnchor)> {
    let center_x = feasible
        .iter()
        .min_by(|a, b| a.x.abs().total_cmp(&b.x.abs()))
        .expect("non-empty")
        .x;
    let deepest_x = feasible
        .iter()
        .min_by(|a, b| {
            a.rest_mm
                .total_cmp(&b.rest_mm)
                .then(a.x.abs().total_cmp(&b.x.abs()))
        })
        .expect("non-empty")
        .x;
    let mut representatives: Vec<(f64, PlacementAnchor)> = Vec::new();
    for (x, anchor) in [
        (deepest_x, PlacementAnchor::Profile),
        (center_x, PlacementAnchor::Center),
        (feasible[feasible.len() - 1].x, PlacementAnchor::Nose),
        (feasible[0].x, PlacementAnchor::Tail),
    ] {
        match representatives.iter_mut().find(|(key, _)| *key == x) {
            Some(entry) => entry.1 = anchor,
            None => representatives.push((x, anchor)),
        }
    }
    representatives.sort_by(|a, b| a.0.total_cmp(&b.0));
    representatives
}

/// Scan x positions along the deck and drape the lattice over the exact inner
/// surface: every bottom-layer cell settles onto its own floor as a cylinder,
/// and each upper cell rests on its actual neighbours, preserving the
/// vertical spacing of the lattice pair-wise. Out of all feasible positions
/// only representatives are kept: tail-most, nose-most, the one closest to
/// the deck centre, and the deepest.
fn profile_placements(request: &ProfilePlacementRequest<'_>) -> (Vec<ProfilePlacement>, u32) {
    let container = request.container;
    let local_bounds = request.local_bounds;
    let tail_x = container.min[0] - local_bounds.min[0];
    let nose_x = container.max[0] - local_bounds.max[0];
    if tail_x > nose_x {
        return (Vec::new(), 0);
    }
    let x_offsets = scan_offsets(tail_x, nose_x);
    let y_offset = -(local_bounds.min[1] + local_bounds.max[1]) / 2.0;
    let layer_count = request.cell_layers.iter().copied().max().unwrap_or(0) as usize + 1;
    let mut by_layer: Vec<Vec<usize>> = vec![Vec::new(); layer_count];
    for (index, &layer) in request.cell_layers.iter().enumerate() {
        by_layer[layer as usize].push(index);
    }
    let supports = support_pairs(request, &by_layer);
    let top_limit_z = heightmap::cylinder_top_limit_z(
        request.enclosure,
        &ProfileCylinder {
            center_x_mm: 0.0,
            center_y_mm: 0.0,
            axis: request.orientation,
            radius_mm: request.cylinder_radius_mm,
            half_length_mm: request.cylinder_half_length_mm,
        },
    );

    let mut draper = Draper {
        request,
        y_offset,
        layer_count,
        by_layer,
        supports,
        top_limit_z,
        near_misses: Vec::new(),
        near_miss_x: None,
        near_miss_overflow: f64::INFINITY,
    };

    let mut feasible: Vec<Candidate> = Vec::new();
    let scanned_count = x_offsets.len() as u32;
    for &x in &x_offsets {
        if let Some(candidate) = draper.evaluate(x) {
            feasible.push(candidate);
        }
    }
    if feasible.is_empty() && !draper.near_misses.is_empty() {
        draper.refine_near_misses(tail_x, nose_x, &mut feasible);
    }
    if feasible.is_empty() {
        return (Vec::new(), scanned_count);
    }
    draper.refine_deepest(tail_x, nose_x, &mut feasible);
    feasible.sort_by(|a, b| a.x.total_cmp(&b.x));

    let placements = pick_representatives(&feasible)
        .into_iter()
        .map(|(x, anchor)| {
            let candidate = feasible.iter().find(|item| item.x == x).unwrap();
            let (cell_z, cell_dx) = draper.slide_edge_columns(x, &candidate.cell_z);
            ProfilePlacement {
                anchor,
                x_offset: x,
                y_offset,
                cell_z,
                cell_dx,
            }
        })
        .collect();
    (placements, scanned_count)
}

/// Wall and lid clearance for a settled pack; the floor contact itself is 0.
fn profile_clearance(container: &Box3D, bounds: &Box3D) -> f64 {
    [
        bounds.min[0] - container.min[0],
        container.max[0] - bounds.max[0],
        bounds.min[1] - container.min[1],
        container.max[1] - bounds.max[1],
        container.max[2] - bounds.max[2],
    ]
    .into_iter()
    .fold(f64::INFINITY, f64::min)
}

/// Hard physical guard: no two cylinders may overlap, whatever lattice
/// produced them. Cells share one orientation, so a pair collides only when
/// both the axial spans and the radial cross-sections overlap.
fn cells_physically_separated(
    cells: &[Vec3],
    axial: usize,
    radial_min_mm: f64,
    axial_min_mm: f64,
) -> bool {
    let radial_a = if axial == 0 { 1 } else { 0 };
    let radial_b = if axial == 2 { 1 } else { 2 };
    let radial_min = (radial_min_mm - 1e-3).max(0.0);
    let radial_min_sq = radial_min * radial_min;
    let axial_min = (axial_min_mm - 1e-3).max(0.0);
    for i in 0..cells.len() {
        for j in i + 1..cells.len() {
            if (cells[i][axial] - cells[j][axial]).abs() >= axial_min {
                continue;
            }
            let da = cells[i][radial_a] - cells[j][radial_a];
            let db = cells[i][radial_b] - cells[j][radial_b];
            if da * da + db * db < radial_min_sq {
                return false;
            }
        }
    }
    true
}

fn empty_free_box() -> LargestFreeBox {
    LargestFreeBox {
        box_: Box3D {
            min: [0.0; 3],
            max: [0.0; 3],
        },
        volume_mm3: 0.0,
    }
}

fn axis_label(axis: Axis) -> &'static str {
    match axis {
        Axis::X => "x",
        Axis::Y => "y",
        Axis::Z => "z",
    }
}

fn mode_label(mode: PackingMode) -> &'static str {
    match mode {
        PackingMode::Brick => "brick",
        PackingMode::Staggered => "staggered",
    }
}

fn anchor_label(anchor: PlacementAnchor) -> &'static str {
    match anchor {
        PlacementAnchor::Tail => "tail",
        PlacementAnchor::Center => "center",
        PlacementAnchor::Nose => "nose",
        PlacementAnchor::Profile => "profile",
    }
}

fn grid_label(grid: Grid3) -> String {
    format!("{}x{}x{}", grid[0], grid[1], grid[2])
}

fn canonical_plan_key(plan: &PackPlan) -> String {
    let size = box_size(&plan.bounds).map(|value| jsmath::to_fixed(value, 2));
    let center: Vec<String> = (0..3)
        .map(|axis| jsmath::to_fixed((plan.bounds.min[axis] + plan.bounds.max[axis]) / 2.0, 2))
        .collect();
    [
        axis_label(plan.orientation).to_owned(),
        mode_label(plan.packing_mode).to_owned(),
        plan.stagger_row_axis
            .map(axis_label)
            .unwrap_or("-")
            .to_owned(),
        grid_label(plan.parallel_factors),
        grid_label(plan.series_factors),
        anchor_label(plan.anchor).to_owned(),
        center.join("x"),
        size.join("x"),
    ]
    .join("|")
}

/// Stable identity of a lattice choice: survives tolerance and enclosure
/// edits that reshuffle plan ids, so the UI can keep the user's selection.
pub fn plan_signature(plan: &PackPlan) -> String {
    [
        mode_label(plan.packing_mode).to_owned(),
        axis_label(plan.orientation).to_owned(),
        plan.stagger_row_axis
            .map(axis_label)
            .unwrap_or("-")
            .to_owned(),
        grid_label(plan.parallel_factors),
        grid_label(plan.series_factors),
        anchor_label(plan.anchor).to_owned(),
    ]
    .join("|")
}

fn range(values: impl Iterator<Item = f64>) -> (f64, f64) {
    values.fold((f64::INFINITY, f64::NEG_INFINITY), |(min, max), v| {
        (min.min(v), max.max(v))
    })
}

fn normalized_inverse(value: f64, (min, max): (f64, f64)) -> f64 {
    if (max - min).abs() < 1e-9 {
        1.0
    } else {
        1.0 - (value - min) / (max - min)
    }
}

fn normalized(value: f64, (min, max): (f64, f64)) -> f64 {
    if (max - min).abs() < 1e-9 {
        1.0
    } else {
        (value - min) / (max - min)
    }
}

/// Relative weight of every ranking criterion; they sum to 1.
struct RankWeights {
    /// Centre of mass close to the requested x.
    center: f64,
    /// Short S-chain.
    chain: f64,
    /// Clearance to the enclosure walls and lid.
    clearance: f64,
    /// Largest free box left for components.
    free: f64,
    /// Small envelope.
    compact: f64,
    /// Manufacturability (brick lattice, few layers).
    manufacturing: f64,
}

const RANK_WEIGHTS: RankWeights = RankWeights {
    center: 0.22,
    chain: 0.18,
    clearance: 0.15,
    free: 0.15,
    compact: 0.15,
    manufacturing: 0.15,
};

/// Score every plan 0..100 relative to the others and sort best first.
fn rank_plans(mut plans: Vec<PackPlan>) -> Vec<PackPlan> {
    if plans.is_empty() {
        return plans;
    }
    let chain_range = range(plans.iter().map(|p| p.metrics.series_chain_length_mm));
    let center_range = range(plans.iter().map(|p| p.metrics.center_offset_mm));
    let clearance_range = range(plans.iter().map(|p| p.metrics.min_clearance_mm));
    let free_range = range(plans.iter().map(|p| p.metrics.largest_free_box.volume_mm3));
    let envelope_range = range(plans.iter().map(|p| box_volume(&p.bounds)));
    let w = &RANK_WEIGHTS;
    for plan in &mut plans {
        let center = normalized_inverse(plan.metrics.center_offset_mm, center_range);
        let chain = normalized_inverse(plan.metrics.series_chain_length_mm, chain_range);
        let clearance = normalized(plan.metrics.min_clearance_mm, clearance_range);
        let free = normalized(plan.metrics.largest_free_box.volume_mm3, free_range);
        let compact = normalized_inverse(box_volume(&plan.bounds), envelope_range);
        let manufacturing = plan.metrics.manufacturability / 100.0;
        plan.metrics.score = jsmath::round(
            (center * w.center
                + chain * w.chain
                + clearance * w.clearance
                + free * w.free
                + compact * w.compact
                + manufacturing * w.manufacturing)
                * 100.0,
        );
    }
    plans.sort_by(|a, b| {
        b.metrics.score.total_cmp(&a.metrics.score).then(
            a.metrics
                .series_chain_length_mm
                .total_cmp(&b.metrics.series_chain_length_mm),
        )
    });
    plans
}

/* ------------------------------------------------------------ enumeration */

#[derive(Debug, thiserror::Error)]
pub enum EnumerationError {
    #[error(transparent)]
    HeightMap(#[from] HeightMapError),
}

/// One independent unit of work: a lattice shape before placement.
#[derive(Clone, Copy)]
struct Task {
    orientation: Axis,
    mode: PackingMode,
    stagger_row_axis: Option<Axis>,
    parallel_factors: Grid3,
    series_factors: Grid3,
}

struct Context<'a> {
    config: &'a PlannerConfig,
    cell: &'a CellSpec,
    container: Box3D,
    enclosure_volume: f64,
    tolerance: CompiledTolerances,
}

pub fn enumerate_pack_plans(
    request: &EnumerationRequest,
) -> Result<EnumerationResponse, EnumerationError> {
    let config = &request.config;
    let enclosure = &config.enclosure;
    let pack = &config.pack;
    heightmap::ensure_compiled(enclosure)?;
    let context = Context {
        config,
        cell: &request.cell,
        container: enclosure_bounds(enclosure),
        enclosure_volume: geometry::enclosure_volume(enclosure),
        tolerance: compile_tolerances(&pack.tolerance_stack),
    };
    let parallel_factors = factor_triples(pack.parallel_count);
    let series_factors = factor_triples(pack.series_count);

    let mut tasks = Vec::new();
    for &orientation in pack.orientation.axes() {
        let radial_axes: Vec<Axis> = Axis::ALL
            .into_iter()
            .filter(|axis| *axis != orientation)
            .collect();
        for &mode in &pack.packing_modes {
            let stagger_axes: Vec<Option<Axis>> = match mode {
                PackingMode::Staggered => radial_axes.iter().map(|axis| Some(*axis)).collect(),
                PackingMode::Brick => vec![None],
            };
            for stagger_row_axis in stagger_axes {
                for &parallel in &parallel_factors {
                    for &series in &series_factors {
                        tasks.push(Task {
                            orientation,
                            mode,
                            stagger_row_axis,
                            parallel_factors: parallel,
                            series_factors: series,
                        });
                    }
                }
            }
        }
    }

    // Tasks are independent; results are gathered back in task order so the
    // de-duplication below (and with it every plan id) stays deterministic.
    let results: Vec<(Vec<PackPlan>, u32)> = tasks
        .par_iter()
        .map(|task| run_task(&context, *task))
        .collect();

    let mut plans = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut explored_count = 0;
    for (candidates, explored) in results {
        explored_count += explored;
        for mut plan in candidates {
            let key = canonical_plan_key(&plan);
            if seen.contains(&key) {
                continue;
            }
            seen.push(key.clone());
            plan.id = format!(
                "layout-{}-{}",
                seen.len(),
                (jsmath::hash_string(&key) as i64).abs()
            );
            plans.push(plan);
        }
    }
    Ok(EnumerationResponse {
        plans: rank_plans(plans),
        explored_count,
    })
}

/// A lattice shape in local coordinates, before placement: cell centres with
/// their lattice layer, the groups routed into one S-chain, and the sizes
/// every containment check works with.
struct Lattice {
    actual_cell_size: Vec3,
    /// Sleeved cell plus radial / axial tolerance layers.
    reservation_cell_size: Vec3,
    axial: usize,
    /// One of the two radial axes; both share the reservation diameter.
    radial_index: usize,
    groups: Vec<LocalGroup>,
    /// Index of the first cell of every group in `cells`.
    group_starts: Vec<usize>,
    cells: Vec<Vec3>,
    cell_layers: Vec<u32>,
    layer_count: u32,
    /// Group indices in S-chain order.
    routed: Vec<usize>,
    /// Centre distance up to which two cells of adjacent layers support each other.
    support_distance_mm: f64,
}

impl Lattice {
    /// Cells of one group.
    fn group_cells<'a, T>(&self, group_index: usize, items: &'a [T]) -> &'a [T] {
        let start = self.group_starts[group_index];
        &items[start..start + self.groups[group_index].cell_positions.len()]
    }

    fn separated(&self, cells: &[Vec3]) -> bool {
        cells_physically_separated(
            cells,
            self.axial,
            self.reservation_cell_size[self.radial_index],
            self.reservation_cell_size[self.axial],
        )
    }
}

/// Build the local lattice of a task, or `None` when the task is degenerate
/// (a single-row stagger), exceeds the layer limit or overlaps itself.
fn build_lattice(context: &Context<'_>, task: Task) -> Option<Lattice> {
    let Task {
        orientation,
        mode,
        stagger_row_axis,
        parallel_factors: p_factors,
        series_factors: s_factors,
    } = task;
    let tolerance = &context.tolerance;
    let cell = context.cell;
    let axial = orientation.index();
    let radial_axes: Vec<usize> = (0..3).filter(|axis| *axis != axial).collect();
    let actual_cell_size = cell_size_for_orientation(
        orientation,
        cell.sleeved_diameter_mm,
        cell.sleeved_height_mm,
    );
    let row_axis = stagger_row_axis.map(Axis::index);
    let shift_axis = row_axis.and_then(|row| radial_axes.iter().copied().find(|axis| *axis != row));

    let template = make_group_template(
        p_factors,
        actual_cell_size,
        orientation,
        mode,
        stagger_row_axis,
        tolerance,
    );
    let stagger_in_group = row_axis.is_some_and(|row| p_factors[row] > 1);
    let stagger_across_groups =
        row_axis.is_some_and(|row| p_factors[row] == 1 && s_factors[row] > 1);
    // A staggered lattice with a single row degenerates to the brick grid;
    // skip it so brick geometry is not duplicated with a "custom holder"
    // label and a worse manufacturability score.
    if mode == PackingMode::Staggered && !stagger_in_group && !stagger_across_groups {
        return None;
    }
    let cross_stagger = if stagger_across_groups {
        let (row, shift) = (row_axis.unwrap(), shift_axis.unwrap());
        Some(CrossGroupStagger {
            row_axis: row,
            shift_axis: shift,
            row_pitch_mm: tolerance.stagger_row_pitch(
                template.reservation_cell_size[row],
                template.cell_pitch[shift],
            ),
            shift_mm: template.cell_pitch[shift] / 2.0,
        })
    } else {
        None
    };
    let groups = create_local_groups(
        s_factors,
        &template,
        tolerance.between_groups,
        cross_stagger,
    );
    let mut group_starts = Vec::with_capacity(groups.len());
    let mut cells: Vec<Vec3> = Vec::new();
    for group in &groups {
        group_starts.push(cells.len());
        cells.extend_from_slice(&group.cell_positions);
    }
    // Lattice layers are identified from the undraped local z values; the
    // settled heights may differ per cell once draped over terrain.
    let mut distinct_local_z: Vec<f64> = cells
        .iter()
        .map(|p| jsmath::round(p[2] * 100.0) / 100.0)
        .collect();
    distinct_local_z.sort_by(f64::total_cmp);
    distinct_local_z.dedup();
    let layer_count = distinct_local_z.len() as u32;
    if layer_count > context.config.pack.max_layers {
        return None;
    }
    let cell_layers: Vec<u32> = cells
        .iter()
        .map(|p| {
            distinct_local_z
                .iter()
                .position(|z| (z - p[2]).abs() < 0.02)
                .unwrap() as u32
        })
        .collect();

    let radial_index = if axial == 0 { 1 } else { 0 };
    let routed = route_groups(&groups, s_factors);
    let lattice = Lattice {
        actual_cell_size,
        reservation_cell_size: template.reservation_cell_size,
        axial,
        radial_index,
        groups,
        group_starts,
        cells,
        cell_layers,
        layer_count,
        routed,
        support_distance_mm: template.cell_pitch[radial_index]
            .max(template.reservation_size[2] + tolerance.between_groups)
            + 0.6,
    };
    lattice.separated(&lattice.cells).then_some(lattice)
}

/// The pack block (cell reservations plus outer wrap) with the service
/// volumes attached to its faces, and the union of both.
struct Envelope {
    block: Box3D,
    services: Vec<ServiceVolume>,
    bounds: Box3D,
}

fn envelope_of(
    cells: &[Vec3],
    lattice: &Lattice,
    outer_wrap: f64,
    reservations: &[&ServiceReservation],
) -> Envelope {
    let cell_boxes: Vec<Box3D> = cells
        .iter()
        .map(|p| box_from_center_size(*p, lattice.reservation_cell_size))
        .collect();
    let block = expand_box(&union_boxes(&cell_boxes), [outer_wrap; 3]);
    let services: Vec<ServiceVolume> = reservations
        .iter()
        .map(|reservation| ServiceVolume {
            id: reservation.id.clone(),
            label: reservation.label.clone(),
            kind: reservation.kind,
            box_: service_box_for_envelope(reservation, &block),
        })
        .collect();
    let bounds = union_boxes(
        &std::iter::once(block)
            .chain(services.iter().map(|v| v.box_))
            .collect::<Vec<_>>(),
    );
    Envelope {
        block,
        services,
        bounds,
    }
}

/// Where the lattice can go: three anchors in a box, or the representative
/// draped positions in a profiled case. Returns the placements and how many
/// positions were examined.
fn candidate_placements(
    context: &Context<'_>,
    lattice: &Lattice,
    local_bounds: &Box3D,
    rigid: bool,
) -> (Vec<ProfilePlacement>, u32) {
    let tolerance = &context.tolerance;
    match context.config.enclosure.as_height_map() {
        None => {
            let placements = ANCHORS
                .iter()
                .map(|&anchor| {
                    let mut offset = anchor_offset(local_bounds, &context.container, anchor);
                    offset[2] += tolerance.floor;
                    ProfilePlacement {
                        anchor,
                        x_offset: offset[0],
                        y_offset: offset[1],
                        cell_z: lattice.cells.iter().map(|p| p[2] + offset[2]).collect(),
                        cell_dx: vec![0.0; lattice.cells.len()],
                    }
                })
                .collect();
            (placements, ANCHORS.len() as u32)
        }
        Some(height_map) => {
            let radius = lattice.reservation_cell_size[lattice.radial_index] / 2.0;
            let half_length = lattice.reservation_cell_size[lattice.axial] / 2.0;
            profile_placements(&ProfilePlacementRequest {
                enclosure: height_map,
                container: &context.container,
                local_bounds,
                local_cells: &lattice.cells,
                cell_layers: &lattice.cell_layers,
                axial_index: lattice.axial,
                orientation: Axis::ALL[lattice.axial],
                cylinder_radius_mm: radius + tolerance.outer_wrap,
                cylinder_half_length_mm: half_length + tolerance.outer_wrap,
                support_distance_mm: lattice.support_distance_mm,
                rigid,
                floor_mm: tolerance.floor,
            })
        }
    }
}

/// Turn one placement of the lattice into a plan, or `None` when the placed
/// pack does not fit the enclosure after all.
fn assemble_plan(
    context: &Context<'_>,
    task: Task,
    lattice: &Lattice,
    reservations: &[&ServiceReservation],
    placement: &ProfilePlacement,
) -> Option<PackPlan> {
    let enclosure = &context.config.enclosure;
    let pack = &context.config.pack;
    let final_positions: Vec<Vec3> = lattice
        .cells
        .iter()
        .enumerate()
        .map(|(index, p)| {
            [
                p[0] + placement.x_offset + placement.cell_dx[index],
                p[1] + placement.y_offset,
                placement.cell_z[index],
            ]
        })
        .collect();
    // Draping preserves lattice spacing pair-wise; this guards the
    // invariant against future regressions.
    if !lattice.separated(&final_positions) {
        return None;
    }
    let envelope = envelope_of(
        &final_positions,
        lattice,
        context.tolerance.outer_wrap,
        reservations,
    );
    // For a box every bound is checked at once; for the profiled case the
    // cells passed the exact cylinder check while draping, so only the
    // attached service volumes remain to verify.
    let fits = match enclosure.as_height_map() {
        None => geometry::enclosure_contains(enclosure, &envelope.bounds),
        Some(_) => envelope
            .services
            .iter()
            .all(|v| geometry::enclosure_contains(enclosure, &v.box_)),
    };
    if !fits {
        return None;
    }

    let group_centers: Vec<Vec3> = (0..lattice.groups.len())
        .map(|group_index| {
            let positions = lattice.group_cells(group_index, &final_positions);
            let sum = positions.iter().fold([0.0; 3], |sum, p| {
                [sum[0] + p[0], sum[1] + p[1], sum[2] + p[2]]
            });
            sum.map(|value| value / positions.len() as f64)
        })
        .collect();
    let ordered_groups: Vec<SeriesGroup> = lattice
        .routed
        .iter()
        .enumerate()
        .map(|(series_index, &group_index)| {
            let group = &lattice.groups[group_index];
            SeriesGroup {
                id: group.id.clone(),
                series_index: series_index as u32,
                grid: group.grid,
                center: group_centers[group_index],
                cell_ids: (0..group.cell_positions.len())
                    .map(|c| format!("{}-c{c}", group.id))
                    .collect(),
            }
        })
        .collect();
    let mut series_index_of = vec![0u32; lattice.groups.len()];
    for (series_index, &group_index) in lattice.routed.iter().enumerate() {
        series_index_of[group_index] = series_index as u32;
    }
    let cells: Vec<CellPlacement> = lattice
        .groups
        .iter()
        .enumerate()
        .flat_map(|(group_index, group)| {
            let layers = lattice.group_cells(group_index, &lattice.cell_layers);
            let positions = lattice.group_cells(group_index, &final_positions);
            let series_index = series_index_of[group_index];
            (0..group.cell_positions.len()).map(move |cell_index| CellPlacement {
                id: format!("{}-c{cell_index}", group.id),
                group_id: group.id.clone(),
                series_index,
                layer: layers[cell_index],
                position: positions[cell_index],
            })
        })
        .collect();
    let series_path: Vec<Vec3> = ordered_groups.iter().map(|g| g.center).collect();
    let center_of_mass_x_mm = cells.iter().map(|c| c.position[0]).sum::<f64>() / cells.len() as f64;
    let series_chain_length_mm = series_path
        .windows(2)
        .fold(0.0, |sum, pair| sum + distance(pair[0], pair[1]));
    let obstacles: Vec<Box3D> = std::iter::once(envelope.block)
        .chain(envelope.services.iter().map(|v| v.box_))
        .collect();
    let reservation_volume_mm3 = obstacles.iter().fold(0.0, |sum, b| sum + box_volume(b));
    let profiled = enclosure.as_height_map().is_some();
    let length = enclosure.dimensions_mm().length;
    let metrics = LayoutMetrics {
        score: 0.0,
        center_of_mass_x_mm,
        center_of_mass_percent: ((center_of_mass_x_mm + length / 2.0) / length) * 100.0,
        center_offset_mm: (center_of_mass_x_mm - pack.target_center_of_mass_x_mm).abs(),
        series_chain_length_mm,
        min_clearance_mm: if profiled {
            profile_clearance(&context.container, &envelope.bounds)
        } else {
            geometry::enclosure_clearance(enclosure, &envelope.bounds)
        },
        layer_count: lattice.layer_count,
        reservation_volume_mm3,
        utilization_percent: (reservation_volume_mm3 / context.enclosure_volume) * 100.0,
        largest_free_box: if profiled {
            empty_free_box()
        } else {
            largest_empty_axis_aligned_box(&context.container, &obstacles)
        },
        manufacturability: manufacturability(task.mode, lattice.layer_count),
    };
    Some(PackPlan {
        id: String::new(),
        packing_mode: task.mode,
        orientation: task.orientation,
        stagger_row_axis: task.stagger_row_axis,
        parallel_factors: task.parallel_factors,
        series_factors: task.series_factors,
        anchor: placement.anchor,
        cell_size_mm: lattice.actual_cell_size,
        series_order: ordered_groups.iter().map(|g| g.id.clone()).collect(),
        blocks: vec![PackBlock {
            id: "block-0".into(),
            group_ids: ordered_groups.iter().map(|g| g.id.clone()).collect(),
            envelope: envelope.block,
        }],
        cells,
        groups: ordered_groups,
        series_path,
        service_volumes: envelope.services,
        bounds: envelope.bounds,
        metrics,
    })
}

/// 0..100: a brick lattice on one layer scores 100; a custom (staggered)
/// holder costs 25 and every extra layer 8.
fn manufacturability(mode: PackingMode, layer_count: u32) -> f64 {
    let stagger_penalty = if mode == PackingMode::Staggered {
        25.0
    } else {
        0.0
    };
    (100.0 - stagger_penalty - (layer_count as f64 - 1.0) * 8.0).max(0.0)
}

fn run_task(context: &Context<'_>, task: Task) -> (Vec<PackPlan>, u32) {
    let Some(lattice) = build_lattice(context, task) else {
        return (Vec::new(), 0);
    };
    let pack = &context.config.pack;
    let reservations: Vec<&ServiceReservation> = active_service_reservations(pack)
        .filter(|reservation| reservation.enabled)
        .collect();
    let local = envelope_of(
        &lattice.cells,
        &lattice,
        context.tolerance.outer_wrap,
        &reservations,
    );
    let required_size = box_size(&local.bounds);
    let enclosure_size = geometry::dimensions_to_vec3(context.config.enclosure.dimensions_mm());
    if (0..3).any(|axis| required_size[axis] > enclosure_size[axis] + 1e-6) {
        return (Vec::new(), 0);
    }
    // Brick packs stack cells vertically, so a column riding a ramp would
    // push its whole tower up; only staggered lattices drape per column.
    let rigid = task.mode == PackingMode::Brick;
    let (placements, explored) = candidate_placements(context, &lattice, &local.bounds, rigid);
    let plans = placements
        .iter()
        .filter_map(|placement| assemble_plan(context, task, &lattice, &reservations, placement))
        .collect();
    (plans, explored)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn factor_triples_enumerates_every_ordered_factorisation() {
        let factors = factor_triples(12);
        assert!(factors.contains(&[1, 1, 12]));
        assert!(factors.contains(&[2, 3, 2]));
        assert!(factors.contains(&[12, 1, 1]));
        assert!(factors.iter().all(|[x, y, z]| x * y * z == 12));
        let mut unique = factors.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), factors.len());
    }

    /// Distance from every upper-row cell to its nearest lower-row cell.
    fn nesting_distances(stack: Vec<ToleranceLayer>) -> (f64, Vec<f64>) {
        use crate::project::{box_enclosure, default_config};
        let mut config = default_config();
        config.enclosure = box_enclosure(400.0, 200.0, 60.0);
        config.pack.orientation = OrientationRequest::Y;
        config.pack.packing_modes = vec![PackingMode::Staggered];
        config.pack.tolerance_stack = stack;
        let cell = crate::library::cell(&config.pack.cell_id).clone();
        let response = enumerate_pack_plans(&EnumerationRequest {
            config,
            cell: cell.clone(),
        })
        .unwrap();
        let plan = response
            .plans
            .iter()
            .find(|plan| plan.stagger_row_axis == Some(Axis::Z) && plan.metrics.layer_count == 2)
            .expect("a two-layer staggered plan");
        let lower: Vec<Vec3> = plan
            .cells
            .iter()
            .filter(|c| c.layer == 0)
            .map(|c| c.position)
            .collect();
        let distances = plan
            .cells
            .iter()
            .filter(|c| c.layer == 1)
            .map(|upper| {
                lower
                    .iter()
                    .map(|low| distance(*low, upper.position))
                    .fold(f64::INFINITY, f64::min)
            })
            .collect();
        (cell.sleeved_diameter_mm, distances)
    }

    #[test]
    fn spacer_wall_sets_the_nesting_distance_between_staggered_rows() {
        let stack = crate::project::default_tolerance_stack();
        let radial = sum_tolerance(&stack, ToleranceApplication::Radial);
        let compound = sum_tolerance(&stack, ToleranceApplication::BetweenCells);
        let holder_wall = sum_tolerance(&stack, ToleranceApplication::BetweenColumns);
        let spacer_wall = sum_tolerance(&stack, ToleranceApplication::BetweenRows);
        assert!(holder_wall > 0.0 && spacer_wall > 0.0);

        // With a spacer the upper row touches the lower one through its web.
        let (diameter, with_spacer) = nesting_distances(stack.clone());
        for d in &with_spacer {
            assert!((d - (diameter + 2.0 * radial + compound + spacer_wall)).abs() < 1e-6);
        }

        // Without it the rows nest at the compound gap, closer than the
        // lateral pitch that still carries the holder wall.
        let mut bare = stack;
        for layer in &mut bare {
            if layer.application == ToleranceApplication::BetweenRows {
                layer.thickness_mm = 0.0;
            }
        }
        let (_, nested) = nesting_distances(bare);
        for d in &nested {
            assert!(
                (d - (diameter + 2.0 * radial + compound)).abs() < 1e-6,
                "{d}"
            );
        }
    }

    #[test]
    fn serpentine_alternates_direction_per_row() {
        let path = serpentine_coordinates([2, 3, 1], [1, 0, 2]);
        assert_eq!(
            path,
            vec![
                [0, 0, 0],
                [1, 0, 0],
                [1, 1, 0],
                [0, 1, 0],
                [0, 2, 0],
                [1, 2, 0]
            ]
        );
    }
}
