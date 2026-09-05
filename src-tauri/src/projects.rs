//! Project files on disk plus the list of recently opened ones.
//!
//! A project is the JSON the app has always exported (`ProjectFile`, schema
//! 2). Loading validates it against the libraries and the registered
//! enclosure assets so a broken file is reported instead of half-applied.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use deckpack_core::project::{PROJECT_SCHEMA_VERSION, ProjectFile};
use deckpack_core::{EnclosureSpec, assets, library};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};

const RECENT_LIMIT: usize = 10;

#[derive(Serialize, Deserialize, Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    /// Unix seconds of the last open or save.
    pub opened_at: u32,
}

fn recent_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("no app data directory: {error}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
    Ok(dir.join("recent-projects.json"))
}

fn read_recent(app: &AppHandle) -> Vec<RecentProject> {
    let Ok(path) = recent_file(app) else {
        return Vec::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_recent(app: &AppHandle, recent: &[RecentProject]) -> Result<(), String> {
    let path = recent_file(app)?;
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(recent).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("cannot write {}: {error}", path.display()))
}

fn project_name(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("project")
        .to_owned()
}

fn touch_recent(app: &AppHandle, path: &Path) -> Result<(), String> {
    let path_text = path.to_string_lossy().into_owned();
    let mut recent = read_recent(app);
    recent.retain(|entry| entry.path != path_text);
    recent.insert(
        0,
        RecentProject {
            path: path_text,
            name: project_name(path),
            opened_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as u32)
                .unwrap_or(0),
        },
    );
    recent.truncate(RECENT_LIMIT);
    write_recent(app, &recent)
}

fn validate(project: &ProjectFile) -> Result<(), String> {
    if project.schema_version != PROJECT_SCHEMA_VERSION {
        return Err(format!(
            "unsupported project schema {} (this build reads {PROJECT_SCHEMA_VERSION})",
            project.schema_version
        ));
    }
    let cell = &project.config.pack.cell_id;
    if !library::cells()
        .iter()
        .any(|candidate| &candidate.id == cell)
    {
        return Err(format!(
            "the project uses cell `{cell}`, which is not in the library"
        ));
    }
    if let EnclosureSpec::MeshHeightmap { asset_id, .. } = &project.config.enclosure
        && assets::with_asset(asset_id, |_| ()).is_err()
    {
        return Err(format!(
            "the project uses enclosure `{asset_id}`, which is not imported on this machine"
        ));
    }
    Ok(())
}

/// Read and validate a project file, recording it as recently used.
#[tauri::command]
#[specta::specta]
pub fn load_project(app: AppHandle, path: String) -> Result<ProjectFile, String> {
    let file = PathBuf::from(&path);
    let text =
        std::fs::read_to_string(&file).map_err(|error| format!("cannot read {path}: {error}"))?;
    let project: ProjectFile = serde_json::from_str(&text)
        .map_err(|error| format!("{path} is not a Deckpack project: {error}"))?;
    validate(&project)?;
    touch_recent(&app, &file)?;
    Ok(project)
}

/// Write a project file (pretty JSON) and record it as recently used.
#[tauri::command]
#[specta::specta]
pub fn save_project(app: AppHandle, path: String, project: ProjectFile) -> Result<(), String> {
    let file = PathBuf::from(&path);
    let text = serde_json::to_string_pretty(&project).map_err(|error| error.to_string())?;
    std::fs::write(&file, text).map_err(|error| format!("cannot write {path}: {error}"))?;
    touch_recent(&app, &file)
}

/// Recently opened projects that still exist on disk, newest first.
#[tauri::command]
#[specta::specta]
pub fn recent_projects(app: AppHandle) -> Vec<RecentProject> {
    read_recent(&app)
        .into_iter()
        .filter(|entry| Path::new(&entry.path).is_file())
        .collect()
}

#[tauri::command]
#[specta::specta]
pub fn forget_project(app: AppHandle, path: String) -> Result<(), String> {
    let mut recent = read_recent(&app);
    recent.retain(|entry| entry.path != path);
    write_recent(&app, &recent)
}
