//! Printable holder solids built with constructive solid geometry.
//!
//! The wave profiles from `deckpack-core` become extruded prisms in the print
//! frame (profile in XY, cell axis along Z); rails with screw holes are then
//! added at both ends so cradle, spacers and cap can be bolted together.
//! `manifold-rust` guarantees a closed, manifold result.

use deckpack_core::ProfilePiece;
use manifold_rust::linalg::{Vec2, Vec3};
use manifold_rust::manifold::Manifold;
use manifold_rust::types::{Error, Polygons};

use crate::stl::{Triangle, write_binary_stl};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CsgOptions {
    /// Width (along the profile) of the rail added at each end; 0 = no rails.
    pub rail_width_mm: f64,
    /// Screw hole through each rail along the pack height; 0 = no holes.
    pub screw_diameter_mm: f64,
    /// Facets of the screw holes.
    pub segments: i32,
}

impl Default for CsgOptions {
    fn default() -> Self {
        Self {
            rail_width_mm: 8.0,
            screw_diameter_mm: 3.2,
            segments: 32,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CsgError {
    #[error("profile `{0}` has fewer than two columns")]
    Degenerate(String),
    #[error("manifold operation failed for `{label}`: {status:?}")]
    Manifold { label: String, status: Error },
}

#[derive(Clone, Debug, PartialEq)]
pub struct CsgReport {
    pub label: String,
    pub triangles: usize,
    pub volume_mm3: f64,
    /// Number of through holes (topological genus).
    pub genus: i32,
    pub size_mm: [f64; 3],
}

pub struct CsgPiece {
    pub report: CsgReport,
    pub stl: Vec<u8>,
}

/// Outline of the profile in the print frame: x = t − t₀, y = z − z_base.
fn outline(piece: &ProfilePiece) -> Result<Polygons, CsgError> {
    let n = piece.t.len();
    if n < 2 {
        return Err(CsgError::Degenerate(piece.label.clone()));
    }
    let t0 = piece.t[0];
    let z_base = piece.bottom.iter().copied().fold(f64::INFINITY, f64::min);
    let thickness = |i: usize| piece.top[i] - piece.bottom[i];
    let mut polygons = Vec::new();
    let mut start = 0;
    while start + 1 < n {
        // A zero-thickness stretch is a cell cutout, not a web to fill in.
        // Split it into separate outlines instead of adding material inside
        // the bores just to keep a single polygon connected.
        while start + 1 < n && thickness(start) <= 0.0 && thickness(start + 1) <= 0.0 {
            start += 1;
        }
        if start + 1 == n {
            break;
        }
        let mut end = start + 1;
        while end + 1 < n && thickness(end) > 0.0 {
            end += 1;
        }
        let mut polygon = Vec::with_capacity(2 * (end - start + 1));
        for i in start..=end {
            polygon.push(Vec2::new(piece.t[i] - t0, piece.bottom[i] - z_base));
        }
        for i in (start..=end).rev() {
            polygon.push(Vec2::new(piece.t[i] - t0, piece.top[i] - z_base));
        }
        polygons.push(polygon);
        start = end;
    }
    Ok(polygons)
}

fn check(label: &str, solid: Manifold) -> Result<Manifold, CsgError> {
    match solid.status() {
        Error::NoError => Ok(solid),
        status => Err(CsgError::Manifold {
            label: label.to_owned(),
            status,
        }),
    }
}

/// The plain extruded profile.
pub fn piece_solid(piece: &ProfilePiece) -> Result<Manifold, CsgError> {
    let polygon = outline(piece)?;
    check(
        &piece.label,
        Manifold::extrude(&polygon, piece.length_mm, 0, 0.0, Vec2::new(1.0, 1.0)),
    )
}

/// Lateral span shared by every piece of a holder, so rails and screw holes
/// line up across cradle, spacers and cap even though each profile is
/// trimmed differently at its ends.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RailSpan {
    pub t_min: f64,
    pub t_max: f64,
}

impl RailSpan {
    pub fn of(pieces: &[ProfilePiece]) -> Option<Self> {
        let mut span: Option<Self> = None;
        for piece in pieces {
            let (Some(&first), Some(&last)) = (piece.t.first(), piece.t.last()) else {
                continue;
            };
            span = Some(match span {
                Some(s) => Self {
                    t_min: s.t_min.min(first),
                    t_max: s.t_max.max(last),
                },
                None => Self {
                    t_min: first,
                    t_max: last,
                },
            });
        }
        span
    }
}

/// Profile prism plus end rails with screw holes. `span` positions the rails;
/// it defaults to the piece's own extent.
pub fn piece_with_rails(
    piece: &ProfilePiece,
    options: &CsgOptions,
    span: Option<RailSpan>,
) -> Result<Manifold, CsgError> {
    let mut solid = piece_solid(piece)?;
    if options.rail_width_mm <= 0.0 {
        return Ok(solid);
    }
    let n = piece.t.len();
    let t0 = piece.t[0];
    let width = piece.t[n - 1] - t0;
    let span = span.unwrap_or(RailSpan {
        t_min: t0,
        t_max: piece.t[n - 1],
    });
    let z_base = piece.bottom.iter().copied().fold(f64::INFINITY, f64::min);
    let height = piece.top.iter().copied().fold(f64::NEG_INFINITY, f64::max) - z_base;
    let rail = options.rail_width_mm;
    // Each rail runs from the shared span edge outward and back to the first
    // (last) profile column, so trimmed slivers leave no gap.
    let blocks = [
        (span.t_min - t0 - rail, 0.0),
        (width, span.t_max - t0 + rail - width),
    ];
    for (x, extra) in blocks {
        let (x0, x1) = if extra > 0.0 {
            (x, x + extra)
        } else {
            (x, 0.0f64.max(x + rail).max(x + rail))
        };
        let (x0, x1) = if x0 <= x1 { (x0, x1) } else { (x1, x0) };
        let block = Manifold::cube(Vec3::new(x1 - x0, height, piece.length_mm), false)
            .translate(Vec3::new(x0, 0.0, 0.0));
        solid = check(&piece.label, solid.union(&block))?;
    }
    if options.screw_diameter_mm > 0.0 {
        // The screw runs along the pack height (profile y) so one bolt passes
        // through the rails of cradle, spacers and cap at the same spot.
        for center in [span.t_min - t0 - rail / 2.0, span.t_max - t0 + rail / 2.0] {
            let hole = Manifold::cylinder(
                height + 2.0,
                options.screw_diameter_mm / 2.0,
                -1.0,
                options.segments,
            )
            .rotate(-90.0, 0.0, 0.0)
            .translate(Vec3::new(center, -1.0, piece.length_mm / 2.0));
            solid = check(&piece.label, solid.difference(&hole))?;
        }
    }
    Ok(solid)
}

/// Triangles of a manifold solid.
pub fn triangles(solid: &Manifold) -> Vec<Triangle> {
    let mesh = solid.get_mesh_gl(0);
    let stride = mesh.num_prop.max(3) as usize;
    let vertex = |index: u32| -> [f64; 3] {
        let base = index as usize * stride;
        [
            mesh.vert_properties[base] as f64,
            mesh.vert_properties[base + 1] as f64,
            mesh.vert_properties[base + 2] as f64,
        ]
    };
    mesh.tri_verts
        .as_chunks::<3>()
        .0
        .iter()
        .map(|tri| Triangle {
            vertices: [vertex(tri[0]), vertex(tri[1]), vertex(tri[2])],
        })
        .collect()
}

/// Build one printable piece and its report.
pub fn build_piece(
    piece: &ProfilePiece,
    options: &CsgOptions,
    span: Option<RailSpan>,
) -> Result<CsgPiece, CsgError> {
    let solid = piece_with_rails(piece, options, span)?;
    let bounds = solid.bounding_box();
    let size = bounds.size();
    let tris = triangles(&solid);
    Ok(CsgPiece {
        report: CsgReport {
            label: piece.label.clone(),
            triangles: tris.len(),
            volume_mm3: solid.volume(),
            genus: solid.genus(),
            size_mm: [size.x, size.y, size.z],
        },
        stl: write_binary_stl(&tris),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slab() -> ProfilePiece {
        ProfilePiece {
            label: "slab".into(),
            t: vec![0.0, 10.0, 20.0, 30.0],
            top: vec![5.0, 5.0, 5.0, 5.0],
            bottom: vec![0.0; 4],
            length_mm: 12.0,
            axial_center_mm: 0.0,
        }
    }

    #[test]
    fn extruded_slab_has_the_expected_volume() {
        let solid = piece_solid(&slab()).unwrap();
        assert!((solid.volume() - 30.0 * 5.0 * 12.0).abs() < 1e-6);
        assert_eq!(solid.genus(), 0);
    }

    #[test]
    fn cutouts_split_the_profile_without_adding_a_web() {
        let piece = ProfilePiece {
            top: vec![5.0, 0.0, 0.0, 5.0],
            ..slab()
        };
        let solid = piece_solid(&piece).unwrap();
        // Two triangular prisms, with the middle 10 mm left empty.
        assert!((solid.volume() - 2.0 * 10.0 * 5.0 / 2.0 * 12.0).abs() < 1e-6);
    }

    #[test]
    fn rails_add_material_and_two_through_holes() {
        let options = CsgOptions {
            rail_width_mm: 6.0,
            screw_diameter_mm: 3.0,
            ..CsgOptions::default()
        };
        let piece = build_piece(&slab(), &options, None).unwrap();
        assert_eq!(piece.report.genus, 2, "one hole per rail");
        let plain = 30.0 * 5.0 * 12.0;
        let rails = 2.0 * 6.0 * 5.0 * 12.0;
        let holes = 2.0 * std::f64::consts::PI * 1.5f64.powi(2) * 5.0;
        assert!(
            (piece.report.volume_mm3 - (plain + rails - holes)).abs() < 3.0,
            "{}",
            piece.report.volume_mm3
        );
        assert!(piece.report.size_mm[0] > 41.9 && piece.report.size_mm[0] < 42.1);
    }
}

#[cfg(test)]
mod span_tests {
    use super::*;

    #[test]
    fn rails_follow_the_shared_span_not_the_trimmed_piece() {
        let long = ProfilePiece {
            label: "long".into(),
            t: vec![0.0, 10.0, 20.0, 30.0, 40.0],
            top: vec![5.0; 5],
            bottom: vec![0.0; 5],
            length_mm: 10.0,
            axial_center_mm: 0.0,
        };
        let short = ProfilePiece {
            label: "short".into(),
            t: vec![10.0, 20.0, 30.0],
            top: vec![5.0; 3],
            bottom: vec![0.0; 3],
            ..long.clone()
        };
        let span = RailSpan::of(&[long.clone(), short.clone()]).unwrap();
        assert_eq!((span.t_min, span.t_max), (0.0, 40.0));
        let options = CsgOptions {
            rail_width_mm: 6.0,
            screw_diameter_mm: 3.0,
            ..CsgOptions::default()
        };
        let a = build_piece(&long, &options, Some(span)).unwrap();
        let b = build_piece(&short, &options, Some(span)).unwrap();
        // Both pieces span the same assembled extent: -6..46 in row coordinates.
        assert!(
            (a.report.size_mm[0] - 52.0).abs() < 1e-6,
            "{}",
            a.report.size_mm[0]
        );
        assert!(
            (b.report.size_mm[0] - 52.0).abs() < 1e-6,
            "{}",
            b.report.size_mm[0]
        );
        assert_eq!(a.report.genus, 2);
        assert_eq!(b.report.genus, 2);
    }
}

/* --------------------------------------------------- whole-holder builds */

use deckpack_core::HolderPieces;

/// One built piece with the frame data needed to place it back in the
/// enclosure: print coordinates are `(t − t0, z − z_base, s)`.
pub struct BuiltPiece {
    pub report: CsgReport,
    pub solid: Manifold,
    t0: f64,
    z_base: f64,
    axial_start: f64,
}

/// Build every piece of a holder with shared rail positions.
pub fn build_holder(
    layout: &HolderPieces,
    options: &CsgOptions,
) -> Result<Vec<BuiltPiece>, CsgError> {
    let span = RailSpan::of(&layout.pieces);
    layout
        .pieces
        .iter()
        .map(|piece| {
            let solid = piece_with_rails(piece, options, span)?;
            let size = solid.bounding_box().size();
            Ok(BuiltPiece {
                report: CsgReport {
                    label: piece.label.clone(),
                    triangles: solid.num_tri(),
                    volume_mm3: solid.volume(),
                    genus: solid.genus(),
                    size_mm: [size.x, size.y, size.z],
                },
                solid,
                t0: piece.t[0],
                z_base: piece.bottom.iter().copied().fold(f64::INFINITY, f64::min),
                axial_start: piece.axial_center_mm - piece.length_mm / 2.0,
            })
        })
        .collect()
}

/// Triangles of all pieces placed in the enclosure (app coordinates), as a
/// flat `x y z` list for a three.js buffer.
pub fn assembled_positions(layout: &HolderPieces, built: &[BuiltPiece]) -> Vec<f32> {
    let lateral = layout.lateral_index as usize;
    let axial = layout.axial_index as usize;
    // (x, y, s) → (lateral: x+t0, 2: y+z_base, axial: start+s). The axis
    // permutation is odd when the lateral axis is X, which mirrors the
    // winding; swap two vertices then so faces stay outward.
    let flip = lateral == 0;
    let mut out = Vec::new();
    for piece in built {
        let map = |v: [f64; 3]| -> [f32; 3] {
            let mut p = [0.0f64; 3];
            p[lateral] = v[0] + piece.t0;
            p[2] = v[1] + piece.z_base;
            p[axial] = piece.axial_start + v[2];
            [p[0] as f32, p[1] as f32, p[2] as f32]
        };
        for triangle in triangles(&piece.solid) {
            let [a, b, c] = triangle.vertices;
            let (b, c) = if flip { (c, b) } else { (b, c) };
            for v in [map(a), map(b), map(c)] {
                out.extend_from_slice(&v);
            }
        }
    }
    out
}

/// All pieces side by side on the print bed in one binary STL, `gap_mm`
/// apart along X.
pub fn layout_stl(built: &[BuiltPiece], gap_mm: f64) -> Vec<u8> {
    let mut all = Vec::new();
    let mut offset = 0.0;
    for piece in built {
        let bounds = piece.solid.bounding_box();
        let shift = offset - bounds.min.x;
        for mut triangle in triangles(&piece.solid) {
            for v in &mut triangle.vertices {
                v[0] += shift;
            }
            all.push(triangle);
        }
        offset += bounds.size().x + gap_mm;
    }
    write_binary_stl(&all)
}
