//! Replays `fixtures/domain/enumerate` through the Rust enumerator.

mod common;

use common::{assert_close, fixtures};
use deckpack_core::packing::enumerate_pack_plans;
use deckpack_core::*;

#[test]
fn enumerate_pack_plans_matches_typescript() {
    for (name, fixture) in fixtures("enumerate") {
        let request: EnumerationRequest =
            serde_json::from_value(fixture["request"].clone()).unwrap();
        let expected: EnumerationResponse =
            serde_json::from_value(fixture["response"].clone()).unwrap();
        let actual = enumerate_pack_plans(&request).unwrap();
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
