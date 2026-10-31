//! IPC surface of the desktop app: thin wrappers over `deckpack-core`.

use deckpack_core::Dimensions3D;
use deckpack_core::placement::PlacementSuggestion;
use deckpack_core::{
    CellSpec, ComponentPlacement, ComponentSpec, EnclosureSpec, EnumerationRequest,
    EnumerationResponse, HeightMapAsset, HolderCsg, HolderOptions, HolderPieceSummary, PackPlan,
    PlannerConfig, ToleranceLayer, WorkspaceEvaluation, assets, geometry, holder, library, packing,
    placement,
};
use deckpack_mesh::{CsgOptions, assembled_positions, build_holder, layout_stl};
use serde::Serialize;
use specta::Type;

/// What a new project starts from; the single source of the default
/// tolerance stack and service reservations.
#[tauri::command]
#[specta::specta]
pub fn default_config() -> PlannerConfig {
    deckpack_core::project::default_config()
}

#[tauri::command]
#[specta::specta]
pub fn cell_library() -> Vec<CellSpec> {
    library::cells().to_vec()
}

#[tauri::command]
#[specta::specta]
pub fn component_library() -> Vec<ComponentSpec> {
    library::components().to_vec()
}

#[tauri::command]
#[specta::specta]
pub fn enclosure_assets() -> Vec<HeightMapAsset> {
    assets::list()
}

/// Collision and free-volume check of the placed components against the pack
/// and the enclosure. Runs on every drag frame, so it stays synchronous: the
/// work is a few hundred microseconds.
#[tauri::command]
#[specta::specta]
pub fn evaluate_workspace(
    enclosure: EnclosureSpec,
    plan: PackPlan,
    placements: Vec<ComponentPlacement>,
) -> Result<WorkspaceEvaluation, String> {
    geometry::evaluate_workspace(&enclosure, &plan, &placements).map_err(|error| error.to_string())
}

/// Enumerate every feasible pack layout for the request. The search runs on a
/// blocking thread (rayon inside) so the IPC thread stays free; the frontend
/// drops stale responses by request id.
#[tauri::command]
#[specta::specta]
pub async fn enumerate_plans(request: EnumerationRequest) -> Result<EnumerationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        packing::enumerate_pack_plans(&request).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("enumeration task failed: {error}"))?
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HolderExport {
    pub pieces: Vec<HolderPieceSummary>,
    pub byte_length: u32,
    pub path: String,
}

fn csg_options(csg: HolderCsg) -> CsgOptions {
    CsgOptions {
        rail_width_mm: if csg.rails { 8.0 } else { 0.0 },
        ..CsgOptions::default()
    }
}

/// Generate the holder pieces with CSG, lay them out for the print bed and
/// write one binary STL to `path` (chosen through the native save dialog).
#[tauri::command]
#[specta::specta]
pub async fn export_holder_stl(
    plan: PackPlan,
    cell: CellSpec,
    tolerance_stack: Vec<ToleranceLayer>,
    enclosure: EnclosureSpec,
    options: HolderOptions,
    csg: HolderCsg,
    path: String,
) -> Result<HolderExport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let layout =
            holder::compute_holder_pieces(&plan, &cell, &tolerance_stack, &enclosure, &options)
                .map_err(|error| error.to_string())?;
        // Profile summaries carry the wall-thickness check; the bytes come from CSG.
        let summary = holder::build_stl(&layout.pieces, &options);
        let built = build_holder(&layout, &csg_options(csg)).map_err(|error| error.to_string())?;
        let stl = layout_stl(&built, options.layout_gap_mm);
        std::fs::write(&path, &stl).map_err(|error| format!("cannot write {path}: {error}"))?;
        Ok(HolderExport {
            pieces: summary.pieces,
            byte_length: stl.len() as u32,
            path,
        })
    })
    .await
    .map_err(|error| format!("holder export task failed: {error}"))?
}

/// Triangles of the holder placed in the enclosure, as little-endian `f32`
/// `x y z` triplets (raw bytes: too large for JSON on every style change).
/// Registered outside tauri-specta because the raw response has no TypeScript
/// type; `src/scene/holder-mesh.ts` wraps it.
#[tauri::command]
pub fn holder_mesh(
    plan: PackPlan,
    cell: CellSpec,
    tolerance_stack: Vec<ToleranceLayer>,
    enclosure: EnclosureSpec,
    options: HolderOptions,
    csg: HolderCsg,
) -> Result<tauri::ipc::Response, String> {
    if plan.orientation == deckpack_core::Axis::Z {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    }
    let layout =
        holder::compute_holder_pieces(&plan, &cell, &tolerance_stack, &enclosure, &options)
            .map_err(|error| error.to_string())?;
    let built = build_holder(&layout, &csg_options(csg)).map_err(|error| error.to_string())?;
    let positions = assembled_positions(&layout, &built);
    let mut bytes = Vec::with_capacity(positions.len() * 4);
    for value in positions {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

/// Where a new component of this size fits: deck ends first, then the centre
/// line, trying a quarter turn if the flat orientation finds no room.
#[tauri::command]
#[specta::specta]
pub fn suggest_placement(
    enclosure: EnclosureSpec,
    plan: PackPlan,
    existing: Vec<ComponentPlacement>,
    dimensions: Dimensions3D,
) -> Result<Option<PlacementSuggestion>, String> {
    placement::suggest_placement(&enclosure, &plan, &existing, &dimensions)
        .map_err(|error| error.to_string())
}
