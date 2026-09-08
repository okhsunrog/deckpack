//! Replays `fixtures/domain/enumerate` through the Rust enumerator.

mod common;

use common::{assert_close, fixtures};
use deckpack_core::packing::enumerate_pack_plans;
use deckpack_core::*;

/// With `UPDATE_FIXTURES=1` in the environment the test rewrites the recorded
/// response from the current enumerator. Do this only for a deliberate
/// behaviour change and say so in the commit.
fn maybe_update(name: &str, fixture: &serde_json::Value, actual: &EnumerationResponse) -> bool {
    if std::env::var_os("UPDATE_FIXTURES").is_none() {
        return false;
    }
    let mut updated = fixture.clone();
    updated["response"] = serde_json::to_value(actual).unwrap();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../fixtures/domain/enumerate/{name}.json"));
    std::fs::write(&path, serde_json::to_string(&updated).unwrap()).unwrap();
    eprintln!("updated {}", path.display());
    true
}

#[test]
fn enumerate_pack_plans_matches_typescript() {
    for (name, fixture) in fixtures("enumerate") {
        let request: EnumerationRequest =
            serde_json::from_value(fixture["request"].clone()).unwrap();
        let expected: EnumerationResponse =
            serde_json::from_value(fixture["response"].clone()).unwrap();
        let actual = enumerate_pack_plans(&request).unwrap();
        if maybe_update(&name, &fixture, &actual) {
            continue;
        }
        assert_eq!(
            actual.explored_count, expected.explored_count,
            "{name}: exploredCount"
        );
        assert_eq!(
            actual.plans.len(),
            expected.plans.len(),
            "{name}: plan count"
        );
        assert_close(
            &serde_json::to_value(&expected).unwrap(),
            &serde_json::to_value(&actual).unwrap(),
            &name,
        );
    }
}
