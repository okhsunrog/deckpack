//! Shared helpers for the golden-fixture tests.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Absolute tolerance for millimetre-scale results; JS and Rust may differ in
/// the last ulp of transcendental functions.
pub const TOLERANCE: f64 = 1e-6;

/// The fixtures were recorded against the enclosure assets snapshotted in
/// `fixtures/domain/assets`; the bundled assets may since have been
/// regenerated, so every fixture test pins the recorded versions first.
pub fn use_recorded_assets() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/domain/assets");
    for entry in fs::read_dir(&dir).expect("fixtures/domain/assets") {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|ext| ext == "json") {
            let asset: deckpack_core::HeightMapAsset =
                serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            deckpack_core::assets::replace(asset);
        }
    }
}

pub fn fixtures(kind: &str) -> Vec<(String, Value)> {
    use_recorded_assets();
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/domain")
        .join(kind);
    let mut entries: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|_| panic!("missing fixtures in {}", dir.display()))
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    entries.sort();
    assert!(!entries.is_empty(), "no fixtures in {}", dir.display());
    entries
        .into_iter()
        .map(|path| {
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            let value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            (name, value)
        })
        .collect()
}

/// Structural JSON comparison with numeric tolerance; `null` and a missing
/// key are treated alike (TypeScript omits `undefined`).
pub fn assert_close(expected: &Value, actual: &Value, path: &str) {
    match (expected, actual) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            assert!(
                (a - b).abs() <= TOLERANCE * a.abs().max(1.0),
                "{path}: expected {a}, got {b}"
            );
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: array length");
            for (index, (x, y)) in a.iter().zip(b).enumerate() {
                assert_close(x, y, &format!("{path}[{index}]"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().chain(b.keys().filter(|key| !a.contains_key(*key))) {
                match (a.get(key), b.get(key)) {
                    (Some(x), Some(y)) => assert_close(x, y, &format!("{path}.{key}")),
                    (None, Some(Value::Null)) | (Some(Value::Null), None) => {}
                    (Some(_), None) => panic!("{path}.{key}: missing in Rust output"),
                    (None, Some(_)) => panic!("{path}.{key}: extra in Rust output"),
                    (None, None) => unreachable!(),
                }
            }
        }
        _ => assert_eq!(expected, actual, "{path}"),
    }
}
