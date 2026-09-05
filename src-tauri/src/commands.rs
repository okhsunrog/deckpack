//! IPC surface of the desktop app: thin wrappers over `deckpack-core`.

use deckpack_core::{
    CellSpec, ComponentPlacement, ComponentSpec, EnclosureSpec, EnumerationRequest,
    EnumerationResponse, HeightMapAsset, PackPlan, WorkspaceEvaluation, assets, geometry, library,
    packing,
};

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
