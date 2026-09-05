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
    /// Interior columns thinner than this are thickened so the outline stays
    /// a single simple polygon.
    pub min_web_mm: f64,
    /// Facets of the screw holes.
    pub segments: i32,
}

impl Default for CsgOptions {
    fn default() -> Self {
        Self {
            rail_width_mm: 8.0,
            screw_diameter_mm: 3.2,
            min_web_mm: 0.8,
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
fn outline(piece: &ProfilePiece, min_web: f64) -> Result<Polygons, CsgError> {
    let n = piece.t.len();
    if n < 2 {
        return Err(CsgError::Degenerate(piece.label.clone()));
    }
    let t0 = piece.t[0];
    let z_base = piece.bottom.iter().copied().fold(f64::INFINITY, f64::min);
    let mut polygon: Vec<Vec2> = Vec::with_capacity(2 * n);
    for i in 0..n {
        polygon.push(Vec2::new(piece.t[i] - t0, piece.bottom[i] - z_base));
    }
    for i in (0..n).rev() {
        let top = piece.top[i].max(piece.bottom[i] + min_web);
        polygon.push(Vec2::new(piece.t[i] - t0, top - z_base));
    }
    // Counter-clockwise outline for a positive fill.
    let area: f64 = polygon
        .iter()
        .zip(polygon.iter().cycle().skip(1))
        .map(|(a, b)| a.x * b.y - b.x * a.y)
        .sum();
    if area < 0.0 {
        polygon.reverse();
    }
    Ok(vec![polygon])
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
pub fn piece_solid(piece: &ProfilePiece, options: &CsgOptions) -> Result<Manifold, CsgError> {
    let polygon = outline(piece, options.min_web_mm)?;
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
    let mut solid = piece_solid(piece, options)?;
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
        let solid = piece_solid(&slab(), &CsgOptions::default()).unwrap();
        assert!((solid.volume() - 30.0 * 5.0 * 12.0).abs() < 1e-6);
        assert_eq!(solid.genus(), 0);
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
