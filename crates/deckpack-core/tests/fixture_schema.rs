//! The golden fixtures under `fixtures/domain` were written by the
//! TypeScript implementation. Every payload must survive a Rust round trip
//! unchanged, which pins the serde model to the JSON the UI already speaks.

use std::fs;
use std::path::{Path, PathBuf};

use deckpack_core::*;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

fn fixtures(kind: &str) -> Vec<(String, Value)> {
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

/// JSON equality that treats `12` and `12.0` as the same number: the
/// TypeScript writer prints integral doubles without a fraction.
fn assert_equivalent(expected: &Value, actual: &Value, path: &str) {
    match (expected, actual) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            assert!(a == b, "{path}: expected {a}, got {b}");
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: array length");
            for (index, (x, y)) in a.iter().zip(b).enumerate() {
                assert_equivalent(x, y, &format!("{path}[{index}]"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().chain(b.keys()) {
                match (a.get(key), b.get(key)) {
                    (Some(x), Some(y)) => assert_equivalent(x, y, &format!("{path}.{key}")),
                    // TypeScript omits `undefined`; Rust writes `null` for `None`.
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

fn round_trip<T: DeserializeOwned + Serialize>(value: &Value, path: &str) -> T {
    let typed: T = serde_json::from_value(value.clone())
        .unwrap_or_else(|error| panic!("{path}: does not deserialize: {error}"));
    let back = serde_json::to_value(&typed).unwrap();
    assert_equivalent(value, &back, path);
    typed
}

#[test]
fn enumerate_fixtures_round_trip() {
    for (name, fixture) in fixtures("enumerate") {
        round_trip::<EnumerationRequest>(&fixture["request"], &format!("{name}.request"));
        round_trip::<EnumerationResponse>(&fixture["response"], &format!("{name}.response"));
    }
}

#[test]
fn evaluate_fixtures_round_trip() {
    for (name, fixture) in fixtures("evaluate") {
        round_trip::<EnclosureSpec>(&fixture["enclosure"], &format!("{name}.enclosure"));
        round_trip::<PackPlan>(&fixture["plan"], &format!("{name}.plan"));
        round_trip::<Vec<ComponentPlacement>>(
            &fixture["placements"],
            &format!("{name}.placements"),
        );
        round_trip::<WorkspaceEvaluation>(&fixture["result"], &format!("{name}.result"));
    }
}

#[test]
fn holder_fixtures_round_trip() {
    for (name, fixture) in fixtures("holder") {
        round_trip::<PackPlan>(&fixture["plan"], &format!("{name}.plan"));
        round_trip::<CellSpec>(&fixture["cell"], &format!("{name}.cell"));
        round_trip::<Vec<ToleranceLayer>>(
            &fixture["toleranceStack"],
            &format!("{name}.toleranceStack"),
        );
        round_trip::<EnclosureSpec>(&fixture["enclosure"], &format!("{name}.enclosure"));
        round_trip::<HolderOptions>(&fixture["options"], &format!("{name}.options"));
        round_trip::<HolderPieces>(&fixture["pieces"], &format!("{name}.pieces"));
        round_trip::<Vec<HolderPieceSummary>>(
            &fixture["build"]["pieces"],
            &format!("{name}.build.pieces"),
        );
    }
}

#[test]
fn bundled_assets_parse() {
    let spark = assets::height_map_asset(&EnclosureSpec::MeshHeightmap {
        asset_id: "spark-case".into(),
        dimensions_mm: Dimensions3D {
            length: 0.0,
            width: 0.0,
            height: 0.0,
        },
    })
    .unwrap();
    assert_eq!(spark.depth_map.step_mm, 0.5);
    assert!(library::cells().iter().any(|cell| cell.id == "eve-50pl"));
}
