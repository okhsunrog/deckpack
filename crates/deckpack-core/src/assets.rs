//! Bundled enclosure height maps.

use std::sync::{LazyLock, RwLock};

use crate::types::{EnclosureSpec, HeightMapAsset};

const SPARK_CASE_JSON: &str =
    include_str!("../../../src/data/enclosures/spark-case-heightmap.json");

static ASSETS: LazyLock<RwLock<Vec<HeightMapAsset>>> = LazyLock::new(|| {
    let spark: HeightMapAsset =
        serde_json::from_str(SPARK_CASE_JSON).expect("spark-case-heightmap.json is valid");
    RwLock::new(vec![spark])
});

#[derive(Debug, thiserror::Error)]
pub enum AssetError {
    #[error("unknown enclosure asset `{0}`")]
    UnknownAsset(String),
    #[error("enclosure `{0:?}` has no height map")]
    NotAHeightMap(EnclosureSpec),
}

/// Register an additional asset (tests probe synthetic profiles this way;
/// user-imported STL enclosures will arrive through the same door).
pub fn register(asset: HeightMapAsset) {
    let mut assets = ASSETS.write().expect("asset registry poisoned");
    if !assets.iter().any(|existing| existing.id == asset.id) {
        assets.push(asset);
    }
}

/// Replace (or add) an asset and drop any compiled height map for it. Used
/// by tests that must run against a recorded snapshot of an asset.
pub fn replace(asset: HeightMapAsset) {
    let mut assets = ASSETS.write().expect("asset registry poisoned");
    assets.retain(|existing| existing.id != asset.id);
    crate::heightmap::invalidate(&asset.id);
    assets.push(asset);
}

/// Unregister an asset; returns whether it was known.
pub fn remove(id: &str) -> bool {
    let mut assets = ASSETS.write().expect("asset registry poisoned");
    let before = assets.len();
    assets.retain(|existing| existing.id != id);
    crate::heightmap::invalidate(id);
    assets.len() != before
}

pub fn with_asset<R>(id: &str, f: impl FnOnce(&HeightMapAsset) -> R) -> Result<R, AssetError> {
    let assets = ASSETS.read().expect("asset registry poisoned");
    assets
        .iter()
        .find(|asset| asset.id == id)
        .map(f)
        .ok_or_else(|| AssetError::UnknownAsset(id.to_owned()))
}

pub fn height_map_asset(spec: &EnclosureSpec) -> Result<HeightMapAsset, AssetError> {
    match spec {
        EnclosureSpec::MeshHeightmap { asset_id, .. } => with_asset(asset_id, Clone::clone),
        other => Err(AssetError::NotAHeightMap(other.clone())),
    }
}

pub fn list() -> Vec<HeightMapAsset> {
    ASSETS.read().expect("asset registry poisoned").clone()
}
