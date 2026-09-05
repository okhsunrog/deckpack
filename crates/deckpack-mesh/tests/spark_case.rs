//! The bundled Spark case assets were produced by the retired Python
//! pipeline from `assets/enclosures/spark-case/source/full-2mm.stl`. The Rust
//! importer must reproduce that depth map everywhere except the seam band
//! (app x ∈ [-27, -15] mm), which the Python script flattened by hand.
//!
//! The bundled map was sampled from an earlier revision of that STL: about
//! 0.2 % of its cells differ from what both this importer and today's trimesh
//! produce for the committed source (rim samples up to 1 mm deep, and ±1
//! quantisation step on slopes). That drift is tolerated with explicit bounds
//! so a real regression in the sampler still fails the test.

use std::fs;
use std::path::Path;

use base64::Engine;
use deckpack_core::HeightMapAsset;
use deckpack_mesh::{DepthMapOptions, ImportOptions, import_enclosure_stl};

#[test]
fn reproduces_the_bundled_spark_case_depth_map() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let stl = fs::read(root.join("assets/enclosures/spark-case/source/full-2mm.stl")).unwrap();
    let expected: HeightMapAsset = serde_json::from_str(
        &fs::read_to_string(root.join("src/data/enclosures/spark-case-heightmap.json")).unwrap(),
    )
    .unwrap();

    let imported = import_enclosure_stl(
        &stl,
        &ImportOptions {
            id: "spark-case".into(),
            label: expected.label.clone(),
            model_url: expected.model_url.clone(),
            depth: DepthMapOptions::default(),
        },
    )
    .unwrap();
    let asset = &imported.asset;

    assert_eq!(asset.mesh_triangles, expected.mesh_triangles);
    assert_eq!(asset.depth_map.columns, expected.depth_map.columns);
    assert_eq!(asset.depth_map.rows, expected.depth_map.rows);
    assert_eq!(asset.depth_map.origin_mm, expected.depth_map.origin_mm);
    for (actual, wanted, name) in [
        (
            asset.dimensions_mm.length,
            expected.dimensions_mm.length,
            "length",
        ),
        (
            asset.dimensions_mm.width,
            expected.dimensions_mm.width,
            "width",
        ),
        (
            asset.dimensions_mm.height,
            expected.dimensions_mm.height,
            "height",
        ),
    ] {
        assert!(
            (actual - wanted).abs() < 1e-3,
            "{name}: {actual} vs {wanted}"
        );
    }

    let expected_data = base64::engine::general_purpose::STANDARD
        .decode(&expected.depth_map.data_base64)
        .unwrap();
    let columns = asset.depth_map.columns as usize;
    let step = asset.depth_map.step_mm;
    let origin_x = asset.depth_map.origin_mm[0];
    let band_c0 = ((-27.0 - origin_x) / step).floor() as usize;
    let band_c1 = ((-15.0 - origin_x) / step).ceil() as usize;

    let mut compared = 0usize;
    let mut differing = 0usize;
    let mut coarse = Vec::new();
    for (index, (&actual, &wanted)) in imported
        .depth_map
        .data
        .iter()
        .zip(&expected_data)
        .enumerate()
    {
        let column = index % columns;
        if (band_c0..=band_c1).contains(&column) {
            continue;
        }
        compared += 1;
        if actual == wanted {
            continue;
        }
        differing += 1;
        let rim = wanted <= 4 && actual <= 4;
        let one_step = (actual as i32 - wanted as i32).abs() <= 1;
        if !rim && !one_step {
            coarse.push((index / columns, column, wanted, actual));
        }
    }
    assert!(compared > 200_000, "compared only {compared} samples");
    assert!(
        differing * 400 < compared,
        "{differing} of {compared} samples differ, beyond the known 0.25 % drift"
    );
    assert!(
        coarse.len() * 1000 < compared,
        "{} samples differ by more than one quantisation step: {:?}",
        coarse.len(),
        &coarse[..coarse.len().min(8)]
    );
    let worst = coarse
        .iter()
        .map(|(_, _, w, a)| (*w as i32 - *a as i32).abs())
        .max()
        .unwrap_or(0);
    assert!(
        worst <= 24,
        "a sample differs by {worst} quantisation steps (> 6 mm)"
    );
    assert!((asset.depth_map.min_depth_mm - expected.depth_map.min_depth_mm).abs() < 1e-9);
    assert!((asset.depth_map.max_depth_mm - expected.depth_map.max_depth_mm).abs() < 1e-9);
}
