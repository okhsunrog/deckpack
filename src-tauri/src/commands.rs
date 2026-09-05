//! IPC surface of the desktop app: thin wrappers over `deckpack-core`.

use deckpack_core::{CellSpec, ComponentSpec, HeightMapAsset, assets, library};

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
