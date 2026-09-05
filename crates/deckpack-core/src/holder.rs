//! Analytic cell-holder generator: printable wave combs built from the exact
//! cell positions of a plan.
//!
//! For every axial row of a horizontal pack it emits a bottom cradle (flat
//! base following the floor, wave top) and one interlayer spacer per layer
//! pair (wave on both sides). Pieces are laid out flat for the printer: the
//! wave profile lies in the XY plane and the cell axis becomes Z, so every
//! wall prints vertically without supports.

use crate::geometry::available_depth_for_box;
use crate::heightmap::{self, HeightMapError};
use crate::jsmath;
use crate::packing::sum_tolerance;
use crate::types::*;

#[derive(Debug, thiserror::Error)]
pub enum HolderError {
    #[error("holder generation supports horizontal cells only")]
    VerticalCells,
    #[error(transparent)]
    HeightMap(#[from] HeightMapError),
}

#[derive(Clone, Copy, Debug)]
struct Disc {
    center: f64,
    z: f64,
}

struct Profile {
    t: Vec<f64>,
    top: Vec<f64>,
    bottom: Vec<f64>,
}

/// Cluster sorted values whose neighbours are closer than `epsilon`.
fn group_by(values: &[f64], epsilon: f64) -> Vec<f64> {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let mut centers: Vec<f64> = Vec::new();
    for value in sorted {
        match centers.last() {
            Some(last) if (value - last).abs() <= epsilon => {}
            _ => centers.push(value),
        }
    }
    centers
}

/// Slab between `slab_bottom` and `slab_top` with circular bites for the
/// discs above (from the top) and below (from the bottom).
#[allow(clippy::too_many_arguments)]
fn wave_profile(
    slab_bottom: f64,
    slab_top: f64,
    bottom_discs: &[Disc],
    top_discs: &[Disc],
    bore: f64,
    t_min: f64,
    t_max: f64,
    step: f64,
) -> Profile {
    let mut profile = Profile {
        t: Vec::new(),
        top: Vec::new(),
        bottom: Vec::new(),
    };
    let mut x = t_min;
    while x <= t_max + 1e-9 {
        let mut hi = slab_top;
        for disc in top_discs {
            let dt = x - disc.center;
            if dt.abs() < bore {
                hi = hi.min(disc.z - (bore * bore - dt * dt).sqrt());
            }
        }
        let mut lo = slab_bottom;
        for disc in bottom_discs {
            let dt = x - disc.center;
            if dt.abs() < bore {
                lo = lo.max(disc.z + (bore * bore - dt * dt).sqrt());
            }
        }
        profile.t.push(x);
        profile.top.push(hi);
        profile.bottom.push(lo.min(hi));
        x += step;
    }
    profile
}

/// Drop degenerate zero-thickness columns at both ends of a profile.
fn trim_empty_ends(profile: Profile) -> Profile {
    let mut first = 0;
    let mut last = profile.t.len() - 1;
    while first < last && profile.top[first] - profile.bottom[first] < 0.05 {
        first += 1;
    }
    while last > first && profile.top[last] - profile.bottom[last] < 0.05 {
        last -= 1;
    }
    Profile {
        t: profile.t[first..=last].to_vec(),
        top: profile.top[first..=last].to_vec(),
        bottom: profile.bottom[first..=last].to_vec(),
    }
}

fn max_of(values: impl Iterator<Item = f64>) -> f64 {
    values.fold(f64::NEG_INFINITY, f64::max)
}

fn min_of(values: impl Iterator<Item = f64>) -> f64 {
    values.fold(f64::INFINITY, f64::min)
}

pub fn compute_holder_pieces(
    plan: &PackPlan,
    cell: &CellSpec,
    tolerance_stack: &[ToleranceLayer],
    enclosure: &EnclosureSpec,
    options: &HolderOptions,
) -> Result<HolderPieces, HolderError> {
    if plan.orientation == Axis::Z {
        return Err(HolderError::VerticalCells);
    }
    heightmap::ensure_compiled(enclosure)?;
    let axial_index = if plan.orientation == Axis::X { 0 } else { 1 };
    let lateral_index = if axial_index == 0 { 1 } else { 0 };
    let radial = sum_tolerance(tolerance_stack, ToleranceApplication::Radial);
    let bore = cell.sleeved_diameter_mm / 2.0 + radial + options.clearance_mm;
    let strip_length = cell.sleeved_height_mm - 2.0 * options.terminal_margin_mm;
    let half_height = cell.sleeved_height_mm / 2.0;
    let enclosure_height = enclosure.dimensions_mm().height;
    let top_z = enclosure_height / 2.0;

    let row_centers = group_by(
        &plan
            .cells
            .iter()
            .map(|placed| placed.position[axial_index])
            .collect::<Vec<_>>(),
        half_height,
    );
    let mut pieces = Vec::new();

    for (row_index, &row_center) in row_centers.iter().enumerate() {
        let row_cells: Vec<&CellPlacement> = plan
            .cells
            .iter()
            .filter(|placed| (placed.position[axial_index] - row_center).abs() < half_height)
            .collect();
        // Layers come from the lattice, not from z: a draped pack has cells of
        // one layer at different heights.
        let mut layer_indices: Vec<u32> = row_cells.iter().map(|placed| placed.layer).collect();
        layer_indices.sort_unstable();
        layer_indices.dedup();
        let layers: Vec<Vec<Disc>> = layer_indices
            .iter()
            .map(|layer| {
                row_cells
                    .iter()
                    .filter(|placed| placed.layer == *layer)
                    .map(|placed| Disc {
                        center: placed.position[lateral_index],
                        z: placed.position[2],
                    })
                    .collect()
            })
            .collect();
        let lateral_all = row_cells
            .iter()
            .map(|placed| placed.position[lateral_index]);
        let t_min = min_of(lateral_all.clone()) - bore - 1.2;
        let t_max = max_of(lateral_all) + bore + 1.2;

        // One wide belt per row, or two narrow bands gripping the cells near
        // their ends like commercial modular holders.
        let edge_width = options.edge_strip_width_mm.min(strip_length / 2.0);
        let band_offset = strip_length / 2.0 - edge_width / 2.0;
        let segments: Vec<(f64, f64, &str)> = if options.style == HolderStyle::Edge
            && strip_length > options.edge_strip_width_mm * 2.0
        {
            vec![
                (row_center - band_offset, edge_width, "-a"),
                (row_center + band_offset, edge_width, "-b"),
            ]
        } else {
            vec![(row_center, strip_length, "")]
        };

        for (segment_center, segment_length, suffix) in segments {
            // Bottom cradle: the underside follows the enclosure floor under
            // the strip, so the piece sits flush on ramps and clears the seam
            // ridge while filling any gap down to the deep floor.
            let bottom_layer = &layers[0];
            let mut cradle = wave_profile(
                -enclosure_height / 2.0,
                max_of(bottom_layer.iter().map(|d| d.z)),
                &[],
                bottom_layer,
                bore,
                t_min,
                t_max,
                options.sample_step_mm,
            );
            let axial_lo = segment_center - segment_length / 2.0;
            let axial_hi = segment_center + segment_length / 2.0;
            for i in 0..cradle.t.len() {
                let t = cradle.t[i];
                let probe = if axial_index == 0 {
                    Box3D {
                        min: [axial_lo, t - 0.25, 0.0],
                        max: [axial_hi, t + 0.25, 0.0],
                    }
                } else {
                    Box3D {
                        min: [t - 0.25, axial_lo, 0.0],
                        max: [t + 0.25, axial_hi, 0.0],
                    }
                };
                let floor_z = top_z - available_depth_for_box(enclosure, &probe);
                cradle.bottom[i] = cradle.bottom[i].max(floor_z).min(cradle.top[i]);
            }
            // Between draped columns of different heights the slab would rise
            // to the tallest one; cap stretches without a nearby cell to a
            // thin web instead.
            for i in 0..cradle.t.len() {
                let near = bottom_layer
                    .iter()
                    .any(|disc| (cradle.t[i] - disc.center).abs() < bore + 0.6);
                if !near {
                    cradle.top[i] = cradle.top[i].min(cradle.bottom[i] + 2.5);
                }
            }
            let cradle = trim_empty_ends(cradle);
            pieces.push(ProfilePiece {
                label: format!("cradle-row{}{suffix}", row_index + 1),
                t: cradle.t,
                top: cradle.top,
                bottom: cradle.bottom,
                length_mm: segment_length,
                axial_center_mm: segment_center,
            });

            // Interlayer spacers between each pair of adjacent layers.
            for index in 0..layers.len().saturating_sub(1) {
                let lower = &layers[index];
                let upper = &layers[index + 1];
                let mut spacer = wave_profile(
                    min_of(lower.iter().map(|d| d.z)),
                    max_of(upper.iter().map(|d| d.z)),
                    lower,
                    upper,
                    bore,
                    t_min,
                    t_max,
                    options.sample_step_mm,
                );
                // The staggered shift leaves each end with cells on one side
                // only. Solid slab there would hold nothing, so cap it to a
                // thin web that follows the existing arc instead.
                let web_mm = 2.5;
                for i in 0..spacer.t.len() {
                    let t = spacer.t[i];
                    let near_upper = upper
                        .iter()
                        .any(|disc| (t - disc.center).abs() < bore + 0.6);
                    let near_lower = lower
                        .iter()
                        .any(|disc| (t - disc.center).abs() < bore + 0.6);
                    if !near_upper && !near_lower {
                        spacer.top[i] = spacer.bottom[i];
                    } else if !near_upper {
                        spacer.top[i] = spacer.top[i].min(spacer.bottom[i] + web_mm);
                    } else if !near_lower {
                        spacer.bottom[i] = spacer.bottom[i].max(spacer.top[i] - web_mm);
                    }
                }
                let spacer = trim_empty_ends(spacer);
                pieces.push(ProfilePiece {
                    label: format!(
                        "spacer-row{}{suffix}-L{}{}",
                        row_index + 1,
                        index + 1,
                        index + 2
                    ),
                    t: spacer.t,
                    top: spacer.top,
                    bottom: spacer.bottom,
                    length_mm: segment_length,
                    axial_center_mm: segment_center,
                });
            }
        }
    }

    Ok(HolderPieces {
        pieces,
        axial_index: axial_index as u8,
        lateral_index: lateral_index as u8,
    })
}

/// Shared prism topology: caps, wave surfaces, and end walls of one piece.
/// `map(t, z, s)` places a profile point at extrusion distance `s`.
pub fn emit_piece_triangles(
    piece: &ProfilePiece,
    map: impl Fn(f64, f64, f64) -> Vec3,
    mut emit: impl FnMut(Vec3, Vec3, Vec3),
) {
    let n = piece.t.len();
    let length = piece.length_mm;
    for i in 0..n.saturating_sub(1) {
        let b0 = map(piece.t[i], piece.bottom[i], 0.0);
        let b1 = map(piece.t[i + 1], piece.bottom[i + 1], 0.0);
        let u0 = map(piece.t[i], piece.top[i], 0.0);
        let u1 = map(piece.t[i + 1], piece.top[i + 1], 0.0);
        let bb0 = map(piece.t[i], piece.bottom[i], length);
        let bb1 = map(piece.t[i + 1], piece.bottom[i + 1], length);
        let uu0 = map(piece.t[i], piece.top[i], length);
        let uu1 = map(piece.t[i + 1], piece.top[i + 1], length);
        // front cap and back cap
        emit(b0, u0, b1);
        emit(b1, u0, u1);
        emit(bb0, bb1, uu0);
        emit(bb1, uu1, uu0);
        // top wave and bottom surfaces
        emit(u0, uu0, u1);
        emit(u1, uu0, uu1);
        emit(b0, b1, bb0);
        emit(b1, bb1, bb0);
    }
    let last = n - 1;
    emit(
        map(piece.t[0], piece.bottom[0], 0.0),
        map(piece.t[0], piece.bottom[0], length),
        map(piece.t[0], piece.top[0], 0.0),
    );
    emit(
        map(piece.t[0], piece.top[0], 0.0),
        map(piece.t[0], piece.bottom[0], length),
        map(piece.t[0], piece.top[0], length),
    );
    emit(
        map(piece.t[last], piece.bottom[last], 0.0),
        map(piece.t[last], piece.top[last], 0.0),
        map(piece.t[last], piece.bottom[last], length),
    );
    emit(
        map(piece.t[last], piece.top[last], 0.0),
        map(piece.t[last], piece.top[last], length),
        map(piece.t[last], piece.bottom[last], length),
    );
}

pub struct HolderBuild {
    pub pieces: Vec<HolderPieceSummary>,
    /// Binary STL: 80-byte header, triangle count, 50 bytes per triangle.
    pub stl: Vec<u8>,
}

/// Lay the pieces out flat on the print bed and write one binary STL.
pub fn build_stl(pieces: &[ProfilePiece], options: &HolderOptions) -> HolderBuild {
    struct Tri {
        normal: Vec3,
        a: Vec3,
        b: Vec3,
        c: Vec3,
    }
    let mut triangles: Vec<Tri> = Vec::new();
    let mut summaries = Vec::new();
    let mut offset_x = 0.0;

    for piece in pieces {
        let before = triangles.len();
        let t0 = piece.t[0];
        let z_base = min_of(piece.bottom.iter().copied());
        let start_x = offset_x;
        let last = piece.t.len() - 1;
        let min_wall = min_of((0..=last).map(|i| piece.top[i] - piece.bottom[i]));
        // Print layout: profile flat in XY, cell axis becomes the vertical Z.
        emit_piece_triangles(
            piece,
            |t, z, s| [start_x + t - t0, z - z_base, s],
            |a, b, c| {
                let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
                let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
                let n = [
                    u[1] * v[2] - u[2] * v[1],
                    u[2] * v[0] - u[0] * v[2],
                    u[0] * v[1] - u[1] * v[0],
                ];
                let len = match jsmath::hypot(&n) {
                    0.0 => 1.0,
                    len => len,
                };
                triangles.push(Tri {
                    normal: [n[0] / len, n[1] / len, n[2] / len],
                    a,
                    b,
                    c,
                });
            },
        );
        summaries.push(HolderPieceSummary {
            label: piece.label.clone(),
            triangle_count: (triangles.len() - before) as u32,
            size_mm: [
                piece.t[last] - t0,
                max_of(piece.top.iter().copied()) - z_base,
                piece.length_mm,
            ],
            min_wall_mm: min_wall,
        });
        offset_x += piece.t[last] - t0 + options.layout_gap_mm;
    }

    let mut stl = Vec::with_capacity(84 + triangles.len() * 50);
    stl.extend_from_slice(&[0u8; 80]);
    stl.extend_from_slice(&(triangles.len() as u32).to_le_bytes());
    for tri in &triangles {
        for vec in [tri.normal, tri.a, tri.b, tri.c] {
            for value in vec {
                stl.extend_from_slice(&(value as f32).to_le_bytes());
            }
        }
        stl.extend_from_slice(&[0u8; 2]);
    }
    HolderBuild {
        pieces: summaries,
        stl,
    }
}

pub fn generate_holder(
    plan: &PackPlan,
    cell: &CellSpec,
    tolerance_stack: &[ToleranceLayer],
    enclosure: &EnclosureSpec,
    options: &HolderOptions,
) -> Result<HolderBuild, HolderError> {
    let layout = compute_holder_pieces(plan, cell, tolerance_stack, enclosure, options)?;
    Ok(build_stl(&layout.pieces, options))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_by_clusters_neighbours() {
        assert_eq!(
            group_by(&[10.0, 0.0, 10.3, 20.0, 0.2], 0.5),
            vec![0.0, 10.0, 20.0]
        );
    }

    #[test]
    fn stl_layout_is_binary_with_header_and_count() {
        let piece = ProfilePiece {
            label: "p".into(),
            t: vec![0.0, 1.0, 2.0],
            top: vec![2.0, 2.0, 2.0],
            bottom: vec![0.0, 0.0, 0.0],
            length_mm: 5.0,
            axial_center_mm: 0.0,
        };
        let build = build_stl(&[piece], &HolderOptions::default());
        let count = build.pieces[0].triangle_count as usize;
        assert_eq!(count, 2 * 8 + 4);
        assert_eq!(build.stl.len(), 84 + count * 50);
        assert_eq!(
            u32::from_le_bytes(build.stl[80..84].try_into().unwrap()),
            count as u32
        );
        assert_eq!(build.pieces[0].size_mm, [2.0, 2.0, 5.0]);
    }
}
