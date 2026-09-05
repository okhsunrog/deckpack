//! IPC surface of the desktop app: thin wrappers over `deckpack-core`.

use deckpack_core::Dimensions3D;
use deckpack_core::placement::PlacementSuggestion;
use deckpack_core::{
    CellSpec, ComponentPlacement, ComponentSpec, EnclosureSpec, EnumerationRequest,
    EnumerationResponse, HeightMapAsset, HolderOptions, HolderPieceSummary, HolderPieces, PackPlan,
    ToleranceLayer, WorkspaceEvaluation, assets, geometry, holder, library, packing, placement,
};
use serde::Serialize;
use specta::Type;

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

/// Wave-comb profiles of the holder for the plan; the scene extrudes them
/// into a preview mesh.
#[tauri::command]
#[specta::specta]
pub fn holder_pieces(
    plan: PackPlan,
    cell: CellSpec,
    tolerance_stack: Vec<ToleranceLayer>,
    enclosure: EnclosureSpec,
    options: HolderOptions,
) -> Result<HolderPieces, String> {
    holder::compute_holder_pieces(&plan, &cell, &tolerance_stack, &enclosure, &options)
        .map_err(|error| error.to_string())
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HolderExport {
    pub pieces: Vec<HolderPieceSummary>,
    pub byte_length: u32,
    pub path: String,
}

/// Generate the holder STL and write it to `path` (chosen by the user
/// through the native save dialog).
#[tauri::command]
#[specta::specta]
pub async fn export_holder_stl(
    plan: PackPlan,
    cell: CellSpec,
    tolerance_stack: Vec<ToleranceLayer>,
    enclosure: EnclosureSpec,
    options: HolderOptions,
    path: String,
) -> Result<HolderExport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let build = holder::generate_holder(&plan, &cell, &tolerance_stack, &enclosure, &options)
            .map_err(|error| error.to_string())?;
        std::fs::write(&path, &build.stl)
            .map_err(|error| format!("cannot write {path}: {error}"))?;
        Ok(HolderExport {
            pieces: build.pieces,
            byte_length: build.stl.len() as u32,
            path,
        })
    })
    .await
    .map_err(|error| format!("holder export task failed: {error}"))?
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
