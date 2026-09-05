//! Enclosures imported by the user from STL files.
//!
//! Each import is stored under `<app data>/enclosures/<id>.json` (the
//! `HeightMapAsset`) and `<id>.stl` (display mesh in app coordinates) and is
//! registered with the core asset registry, so plans can be enumerated
//! against it like against the bundled Spark case.

use std::path::{Path, PathBuf};

use deckpack_core::{HeightMapAsset, assets};
use deckpack_mesh::{DepthMapOptions, ImportOptions, import_enclosure_stl};
use tauri::{AppHandle, Manager};

fn imports_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("no app data directory: {error}"))?
        .join("enclosures");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
    Ok(dir)
}

/// Register every previously imported enclosure. Errors are logged, not
/// fatal: a corrupt file must not keep the app from starting.
pub fn load_imported(app: &AppHandle) {
    let Ok(dir) = imports_dir(app) else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        match std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|text| {
                serde_json::from_str::<HeightMapAsset>(&text).map_err(|e| e.to_string())
            }) {
            Ok(asset) => assets::register(asset),
            Err(error) => log::warn!("skipping enclosure {}: {error}", path.display()),
        }
    }
}

/// Stable, filesystem-safe id: slug of the file name plus a hash of the bytes,
/// so re-importing a changed file yields a new asset.
fn asset_id(source: &Path, bytes: &[u8]) -> String {
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("enclosure");
    let slug: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_owned();
    let hash = bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, b| {
        (h ^ *b as u64).wrapping_mul(0x0100_0000_01b3)
    });
    format!(
        "{}-{:06x}",
        if slug.is_empty() { "enclosure" } else { &slug },
        hash & 0xff_ffff
    )
}

/// Import an STL enclosure and make it available to the planner.
#[tauri::command]
#[specta::specta]
pub async fn import_enclosure(app: AppHandle, path: String) -> Result<HeightMapAsset, String> {
    let dir = imports_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let source = PathBuf::from(&path);
        let bytes =
            std::fs::read(&source).map_err(|error| format!("cannot read {path}: {error}"))?;
        let id = asset_id(&source, &bytes);
        let label = source
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Enclosure")
            .to_owned();
        let stl_path = dir.join(format!("{id}.stl"));
        let imported = import_enclosure_stl(
            &bytes,
            &ImportOptions {
                id: id.clone(),
                label,
                model_url: String::new(),
                depth: DepthMapOptions::default(),
            },
        )
        .map_err(|error| error.to_string())?;
        let mut asset = imported.asset;
        asset.model_path = Some(stl_path.to_string_lossy().into_owned());
        std::fs::write(&stl_path, &imported.display_stl)
            .map_err(|error| format!("cannot write {}: {error}", stl_path.display()))?;
        let json_path = dir.join(format!("{id}.json"));
        std::fs::write(
            &json_path,
            serde_json::to_vec(&asset).map_err(|e| e.to_string())?,
        )
        .map_err(|error| format!("cannot write {}: {error}", json_path.display()))?;
        assets::register(asset.clone());
        Ok(asset)
    })
    .await
    .map_err(|error| format!("import task failed: {error}"))?
}
