//! The golden fixtures under `fixtures/domain` were written by the
//! TypeScript implementation. Every payload must survive a Rust round trip
//! unchanged, which pins the serde model to the JSON the UI already speaks.

mod common;

use common::{assert_close, fixtures};
use deckpack_core::*;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

fn round_trip<T: DeserializeOwned + Serialize>(value: &Value, path: &str) -> T {
    let typed: T = serde_json::from_value(value.clone())
        .unwrap_or_else(|error| panic!("{path}: does not deserialize: {error}"));
    let back = serde_json::to_value(&typed).unwrap();
    assert_close(value, &back, path);
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
