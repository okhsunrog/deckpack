//! Replays `fixtures/domain/evaluate` through the Rust geometry.

mod common;

use common::{assert_close, fixtures};
use deckpack_core::geometry::evaluate_workspace;
use deckpack_core::*;

#[test]
fn evaluate_workspace_matches_typescript() {
    for (name, fixture) in fixtures("evaluate") {
        let enclosure: EnclosureSpec =
            serde_json::from_value(fixture["enclosure"].clone()).unwrap();
        let plan: PackPlan = serde_json::from_value(fixture["plan"].clone()).unwrap();
        let placements: Vec<ComponentPlacement> =
            serde_json::from_value(fixture["placements"].clone()).unwrap();
        let expected: WorkspaceEvaluation =
            serde_json::from_value(fixture["result"].clone()).unwrap();

        let actual = evaluate_workspace(&enclosure, &plan, &placements).unwrap();
        assert_close(
            &serde_json::to_value(&expected).unwrap(),
            &serde_json::to_value(&actual).unwrap(),
            &name,
        );
    }
}
