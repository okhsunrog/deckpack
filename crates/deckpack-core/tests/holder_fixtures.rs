//! Replays `fixtures/domain/holder` through the Rust holder generator and
//! ports the behavioural assertions of the original TypeScript suite.

mod common;

use std::path::Path;

use common::{assert_close, fixtures};
use deckpack_core::geometry::available_depth_for_box;
use deckpack_core::holder::{compute_holder_pieces, generate_holder};
use deckpack_core::packing::enumerate_pack_plans;
use deckpack_core::*;
use sha2::{Digest, Sha256};

/// `UPDATE_FIXTURES=1 cargo test -p deckpack-core --test holder_fixtures`
/// rewrites the recorded outputs from the current generator. Do this only
/// for a deliberate behaviour change and say so in the commit.
fn maybe_update(
    name: &str,
    fixture: &serde_json::Value,
    pieces: &HolderPieces,
    build: &deckpack_core::holder::HolderBuild,
) -> bool {
    if std::env::var_os("UPDATE_FIXTURES").is_none() {
        return false;
    }
    let mut updated = fixture.clone();
    updated["pieces"] = serde_json::to_value(pieces).unwrap();
    updated["build"]["pieces"] = serde_json::to_value(&build.pieces).unwrap();
    updated["build"]["stlByteLength"] = serde_json::json!(build.stl.len());
    let digest: String = Sha256::digest(&build.stl)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    updated["build"]["stlSha256"] = serde_json::json!(digest);
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../fixtures/domain/holder/{name}.json"));
    std::fs::write(&path, serde_json::to_string(&updated).unwrap()).unwrap();
    eprintln!("updated {}", path.display());
    true
}

#[test]
fn holder_pieces_and_stl_match_typescript() {
    for (name, fixture) in fixtures("holder") {
        let plan: PackPlan = serde_json::from_value(fixture["plan"].clone()).unwrap();
        let cell: CellSpec = serde_json::from_value(fixture["cell"].clone()).unwrap();
        let stack: Vec<ToleranceLayer> =
            serde_json::from_value(fixture["toleranceStack"].clone()).unwrap();
        let enclosure: EnclosureSpec =
            serde_json::from_value(fixture["enclosure"].clone()).unwrap();
        let options: HolderOptions = serde_json::from_value(fixture["options"].clone()).unwrap();

        let pieces = compute_holder_pieces(&plan, &cell, &stack, &enclosure, &options).unwrap();
        let build = generate_holder(&plan, &cell, &stack, &enclosure, &options).unwrap();
        if maybe_update(&name, &fixture, &pieces, &build) {
            continue;
        }
        assert_close(
            &fixture["pieces"],
            &serde_json::to_value(&pieces).unwrap(),
            &format!("{name}.pieces"),
        );

        assert_close(
            &fixture["build"]["pieces"],
            &serde_json::to_value(&build.pieces).unwrap(),
            &format!("{name}.build.pieces"),
        );
        assert_eq!(
            build.stl.len() as u64,
            fixture["build"]["stlByteLength"].as_u64().unwrap(),
            "{name}: STL size"
        );
        let digest: String = Sha256::digest(&build.stl)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(
            digest,
            fixture["build"]["stlSha256"].as_str().unwrap(),
            "{name}: STL bytes"
        );
    }
}

fn default_request() -> EnumerationRequest {
    let fixture = fixtures("enumerate")
        .into_iter()
        .find(|(name, _)| name == "spark-12s3p-default")
        .expect("default fixture")
        .1;
    serde_json::from_value(fixture["request"].clone()).unwrap()
}

fn two_layer_staggered(plans: &[PackPlan]) -> &PackPlan {
    plans
        .iter()
        .find(|plan| plan.packing_mode == PackingMode::Staggered && plan.metrics.layer_count == 2)
        .expect("two-layer staggered plan")
}

#[test]
fn edge_style_bands_sit_at_the_terminal_margin() {
    let request = default_request();
    let plans = enumerate_pack_plans(&request).unwrap().plans;
    let plan = two_layer_staggered(&plans);
    let options = HolderOptions {
        style: HolderStyle::Edge,
        ..HolderOptions::default()
    };
    let stack = &request.config.pack.tolerance_stack;
    let build = generate_holder(
        plan,
        &request.cell,
        stack,
        &request.config.enclosure,
        &options,
    )
    .unwrap();
    assert_eq!(build.pieces.len(), 8);
    assert_eq!(
        build
            .pieces
            .iter()
            .filter(|p| p.label.starts_with("cradle"))
            .count(),
        4
    );
    for piece in &build.pieces {
        assert!((piece.size_mm[2] - options.edge_strip_width_mm).abs() < 1e-9);
        assert!(piece.triangle_count > 100);
    }
    let layout = compute_holder_pieces(
        plan,
        &request.cell,
        stack,
        &request.config.enclosure,
        &options,
    )
    .unwrap();
    let half_covered = request.cell.sleeved_height_mm / 2.0 - options.terminal_margin_mm;
    let axial = layout.axial_index as usize;
    for piece in &layout.pieces {
        let row = plan
            .cells
            .iter()
            .map(|c| c.position[axial])
            .min_by(|a, b| {
                (a - piece.axial_center_mm)
                    .abs()
                    .total_cmp(&(b - piece.axial_center_mm).abs())
            })
            .unwrap();
        let outer_edge = (piece.axial_center_mm - row).abs() + piece.length_mm / 2.0;
        assert!(
            (outer_edge - half_covered).abs() < 1e-5,
            "{}: {outer_edge} vs {half_covered}",
            piece.label
        );
    }
}

#[test]
fn spacers_keep_a_printable_wall_and_cradles_follow_the_floor() {
    let request = default_request();
    let plans = enumerate_pack_plans(&request).unwrap().plans;
    let plan = two_layer_staggered(&plans);
    let stack = &request.config.pack.tolerance_stack;
    let enclosure = &request.config.enclosure;
    let options = HolderOptions::default();
    let build = generate_holder(plan, &request.cell, stack, enclosure, &options).unwrap();
    assert_eq!(build.pieces.len(), 4);
    for spacer in build
        .pieces
        .iter()
        .filter(|p| p.label.starts_with("spacer"))
    {
        assert!(
            spacer.min_wall_mm > 0.5,
            "{}: {}",
            spacer.label,
            spacer.min_wall_mm
        );
    }

    let layout = compute_holder_pieces(plan, &request.cell, stack, enclosure, &options).unwrap();
    let top_z = enclosure.dimensions_mm().height / 2.0;
    let cradles: Vec<&ProfilePiece> = layout
        .pieces
        .iter()
        .filter(|p| p.label.starts_with("cradle"))
        .collect();
    assert!(!cradles.is_empty());
    for cradle in cradles {
        let axial_lo = cradle.axial_center_mm - cradle.length_mm / 2.0;
        let axial_hi = cradle.axial_center_mm + cradle.length_mm / 2.0;
        for i in (0..cradle.t.len()).step_by(8) {
            if cradle.top[i] - cradle.bottom[i] < 0.05 {
                continue;
            }
            let t = cradle.t[i];
            let probe = if layout.axial_index == 0 {
                Box3D {
                    min: [axial_lo, t - 0.25, 0.0],
                    max: [axial_hi, t + 0.25, 0.0],
                }
            } else {
                Box3D {
                    min: [t - 0.25, axial_lo, 0.0],
                    max: [t + 0.25, axial_hi, 0.0],
                }
            };
            let floor_z = top_z - available_depth_for_box(enclosure, &probe);
            assert!(
                cradle.bottom[i] >= floor_z - 1e-6,
                "{} dips below the floor at t={t}",
                cradle.label
            );
        }
        let bottoms: Vec<f64> = (0..cradle.t.len())
            .filter(|&i| cradle.top[i] - cradle.bottom[i] > 0.01)
            .map(|i| cradle.bottom[i])
            .collect();
        let spread = bottoms.iter().cloned().fold(f64::NEG_INFINITY, f64::max)
            - bottoms.iter().cloned().fold(f64::INFINITY, f64::min);
        assert!(
            spread > 0.5,
            "{} is flat although the pack straddles the ramp",
            cradle.label
        );
    }
}

#[test]
fn vertical_cells_are_refused() {
    let request = default_request();
    let mut plan = enumerate_pack_plans(&request).unwrap().plans.remove(0);
    plan.orientation = Axis::Z;
    let result = generate_holder(
        &plan,
        &request.cell,
        &request.config.pack.tolerance_stack,
        &request.config.enclosure,
        &HolderOptions::default(),
    );
    assert!(result.is_err());
}
