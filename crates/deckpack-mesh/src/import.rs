//! Whole-file import: STL bytes in, `HeightMapAsset` and display mesh out.

use base64::Engine;
use deckpack_core::{DepthMap, Dimensions3D, HeightMapAsset, HeightMapKind};

use crate::depth::{DepthMapOptions, SampledDepthMap, sample_depth_map};
use crate::stl::{StlError, Triangle, parse_stl, write_binary_stl};

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error(transparent)]
    Stl(#[from] StlError),
    #[error("mesh is flat along {axis}; a closed shell or open tray is required")]
    Degenerate { axis: char },
    #[error("no inner surface found: every sample is a wall")]
    NoFloor,
}

#[derive(Clone, Debug)]
pub struct ImportOptions {
    pub id: String,
    pub label: String,
    /// URL the frontend will load the display mesh from.
    pub model_url: String,
    pub depth: DepthMapOptions,
}

pub struct ImportedEnclosure {
    pub asset: HeightMapAsset,
    /// Binary STL of the shell in app coordinates (X along the deck, Y
    /// across, Z up with the lid plane at `+height / 2`).
    pub display_stl: Vec<u8>,
    pub depth_map: SampledDepthMap,
}

/// Import an enclosure modelled the way printable cases usually are: the
/// open side at low z facing −z, depth growing along +z, the long side along
/// the source Y axis.
pub fn import_enclosure_stl(
    bytes: &[u8],
    options: &ImportOptions,
) -> Result<ImportedEnclosure, ImportError> {
    let triangles = parse_stl(bytes)?;
    import_triangles(&triangles, options)
}

pub fn import_triangles(
    triangles: &[Triangle],
    options: &ImportOptions,
) -> Result<ImportedEnclosure, ImportError> {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for triangle in triangles {
        for vertex in triangle.vertices {
            for axis in 0..3 {
                min[axis] = min[axis].min(vertex[axis]);
                max[axis] = max[axis].max(vertex[axis]);
            }
        }
    }
    for (axis, name) in ['x', 'y', 'z'].into_iter().enumerate() {
        if max[axis] - min[axis] <= 0.0 {
            return Err(ImportError::Degenerate { axis: name });
        }
    }
    let center_x = (min[0] + max[0]) / 2.0;
    let center_y = (min[1] + max[1]) / 2.0;
    let height = max[2] - min[2];
    // App X runs along the deck (source Y), app Y across it (source X).
    let length = max[1] - min[1];
    let width = max[0] - min[0];

    let step = options.depth.step_mm;
    let columns = (length / step).ceil() as usize + 1;
    let rows = (width / step).ceil() as usize + 1;
    let origin = [
        -((columns - 1) as f64 * step) / 2.0,
        -((rows - 1) as f64 * step) / 2.0,
    ];
    let depth_map = sample_depth_map(
        triangles,
        |v| [v[1] - center_y, v[0] - center_x],
        columns,
        rows,
        origin,
        &options.depth,
    );
    let (min_depth, max_depth) = depth_map.depth_range().ok_or(ImportError::NoFloor)?;

    let display: Vec<Triangle> = triangles
        .iter()
        .map(|triangle| Triangle {
            vertices: triangle
                .vertices
                .map(|v| [v[1] - center_y, v[0] - center_x, height / 2.0 - v[2]]),
        })
        .collect();

    let asset = HeightMapAsset {
        id: options.id.clone(),
        label: options.label.clone(),
        kind: HeightMapKind::MeshHeightmap,
        dimensions_mm: Dimensions3D {
            length,
            width,
            height,
        },
        model_url: options.model_url.clone(),
        model_path: None,
        mesh_triangles: triangles.len() as u32,
        depth_map: DepthMap {
            origin_mm: origin,
            step_mm: step,
            columns: columns as u32,
            rows: rows as u32,
            depth_quantization_mm: options.depth.quantization_mm,
            safety_margin_mm: options.depth.safety_margin_mm,
            min_depth_mm: min_depth,
            max_depth_mm: max_depth,
            usable_volume_mm3: depth_map.usable_volume_mm3(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(&depth_map.data),
        },
    };
    Ok(ImportedEnclosure {
        asset,
        display_stl: write_binary_stl(&display),
        depth_map,
    })
}
