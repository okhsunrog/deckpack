//! The bundled Spark case assets (`src/data/enclosures/spark-case-heightmap.json`
//! and `public/models/enclosures/spark-case.stl`) are produced by this crate
//! from `assets/enclosures/spark-case/source/full-2mm-flat.stl`:
//!
//! ```sh
//! deckpack enclosure import assets/enclosures/spark-case/source/full-2mm-flat.stl \
//!   -o spark.json --display public/models/enclosures/spark-case.stl \
//!   --id spark-case --label "Spark case (carbon 2 mm)"
//! ```
//!
//! (then `modelUrl` is set to `/models/enclosures/spark-case.stl` and
//! `modelPath` dropped). The importer must keep reproducing them exactly.

use std::fs;
use std::path::Path;

use deckpack_core::HeightMapAsset;
use deckpack_mesh::{DepthMapOptions, ImportOptions, import_enclosure_stl, parse_stl};

#[test]
fn reproduces_the_bundled_spark_case_assets_exactly() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let stl = fs::read(root.join("assets/enclosures/spark-case/source/full-2mm-flat.stl")).unwrap();
    let expected: HeightMapAsset = serde_json::from_str(
        &fs::read_to_string(root.join("src/data/enclosures/spark-case-heightmap.json")).unwrap(),
    )
    .unwrap();

    let imported = import_enclosure_stl(
        &stl,
        &ImportOptions {
            id: expected.id.clone(),
            label: expected.label.clone(),
            model_url: expected.model_url.clone(),
            depth: DepthMapOptions::default(),
        },
    )
    .unwrap();

    assert_eq!(imported.asset, expected);

    let display = fs::read(root.join("public/models/enclosures/spark-case.stl")).unwrap();
    assert_eq!(
        imported.display_stl, display,
        "display mesh drifted from the importer output"
    );
    assert_eq!(
        parse_stl(&display).unwrap().len() as u32,
        expected.mesh_triangles
    );
}
