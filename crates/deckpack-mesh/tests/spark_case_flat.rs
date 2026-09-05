//! `assets/enclosures/spark-case/source/full-2mm-flat.stl` is the Spark case
//! source mesh with the seam reinforcement remnant removed by
//! `scripts/flatten_spark_seam.py`. The importer has no Spark-specific seam
//! handling, so the cleaned source must yield the flat band on its own:
//!
//! * inside the seam band (app x ∈ [-27, -15] mm) the sampled depth must agree
//!   with the bundled map (which the retired Python pipeline patched by hand)
//!   within one quantisation step for at least 99 % of the cells, and the
//!   floor through the middle must read the full 48 mm the planner probes;
//! * outside the band the cleaning must be invisible: the sampled depth must
//!   equal what the original `full-2mm.stl` produces, cell for cell.
//!
//! The remaining in-band differences are where the bundled map is the odd one
//! out: sloped rim-ledge cells the old vertex snapping smeared (rows at
//! app y ≈ ±92.5 mm), rim cells that already differ between the original
//! source and the bundled map, and the 2 mm wide belt-rib cavity at
//! app y ≈ +79 mm whose bottom the old pipeline pulled 0.5–1 mm deeper.

use std::fs;
use std::path::Path;

use base64::Engine;
use deckpack_core::HeightMapAsset;
use deckpack_mesh::{DepthMapOptions, ImportOptions, ImportedEnclosure, import_enclosure_stl};

const SEAM_BAND_APP_X: (f64, f64) = (-27.0, -15.0);
/// `deckpack_core::heightmap` probes 1 × 60 mm boxes centred on y = 0 for
/// x ∈ [-30, 20] and expects 48 mm everywhere.
const PROBED_APP_X: (f64, f64) = (-30.5, 20.5);
const PROBED_APP_Y: (f64, f64) = (-30.0, 30.0);
const FULL_DEPTH_MM: f64 = 48.0;

fn import(root: &Path, file: &str, expected: &HeightMapAsset) -> ImportedEnclosure {
    let stl = fs::read(root.join("assets/enclosures/spark-case/source").join(file)).unwrap();
    import_enclosure_stl(
        &stl,
        &ImportOptions {
            id: "spark-case".into(),
            label: expected.label.clone(),
            model_url: expected.model_url.clone(),
            depth: DepthMapOptions::default(),
        },
    )
    .unwrap()
}

#[test]
fn flat_source_matches_the_bundled_band_and_the_original_elsewhere() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let expected: HeightMapAsset = serde_json::from_str(
        &fs::read_to_string(root.join("src/data/enclosures/spark-case-heightmap.json")).unwrap(),
    )
    .unwrap();
    let expected_data = base64::engine::general_purpose::STANDARD
        .decode(&expected.depth_map.data_base64)
        .unwrap();

    let original = import(&root, "full-2mm.stl", &expected);
    let flat = import(&root, "full-2mm-flat.stl", &expected);

    // The cleaning only moves vertices strictly inside the band, so the
    // bounding box, and with it the sampling grid, must be untouched.
    assert_eq!(flat.asset.dimensions_mm, original.asset.dimensions_mm);
    assert_eq!(
        flat.asset.depth_map.origin_mm,
        original.asset.depth_map.origin_mm
    );
    assert_eq!(flat.asset.depth_map.columns, expected.depth_map.columns);
    assert_eq!(flat.asset.depth_map.rows, expected.depth_map.rows);
    assert_eq!(flat.depth_map.data.len(), expected_data.len());
    assert!(
        flat.asset.mesh_triangles <= original.asset.mesh_triangles,
        "flattening must not add triangles ({} vs {})",
        flat.asset.mesh_triangles,
        original.asset.mesh_triangles
    );

    let map = &flat.depth_map;
    let step = map.step_mm;
    let [origin_x, origin_y] = map.origin_mm;
    let band_c0 = ((SEAM_BAND_APP_X.0 - origin_x) / step).floor() as usize;
    let band_c1 = ((SEAM_BAND_APP_X.1 - origin_x) / step).ceil() as usize;

    let mut band_cells = 0usize;
    let mut band_equal = 0usize;
    let mut band_within_one = 0usize;
    let mut band_worst = 0i32;
    let mut outside_cells = 0usize;
    let mut outside_differing = Vec::new();
    for row in 0..map.rows {
        for column in 0..map.columns {
            let index = row * map.columns + column;
            let actual = map.data[index] as i32;
            if (band_c0..=band_c1).contains(&column) {
                let wanted = expected_data[index] as i32;
                band_cells += 1;
                let difference = (actual - wanted).abs();
                band_equal += (difference == 0) as usize;
                band_within_one += (difference <= 1) as usize;
                band_worst = band_worst.max(difference);
            } else {
                outside_cells += 1;
                let reference = original.depth_map.data[index] as i32;
                if actual != reference {
                    outside_differing.push((row, column, reference, actual));
                }
            }
        }
    }

    println!(
        "triangles: original {} → flat {}",
        original.asset.mesh_triangles, flat.asset.mesh_triangles
    );
    println!(
        "seam band (columns {band_c0}..={band_c1}): {band_cells} cells, {band_equal} equal to the \
         bundled map, {band_within_one} within one step ({:.2} %), worst difference {band_worst} steps",
        100.0 * band_within_one as f64 / band_cells as f64
    );
    println!(
        "outside the band: {outside_cells} cells, {} differ from the original source",
        outside_differing.len()
    );

    assert!(band_cells > 10_000, "band covers only {band_cells} cells");
    assert!(
        band_within_one * 100 >= band_cells * 99,
        "only {band_within_one} of {band_cells} band cells are within one quantisation step of the \
         bundled map"
    );
    assert!(
        outside_differing.is_empty(),
        "{} cells outside the seam band differ from the original import, e.g. {:?}",
        outside_differing.len(),
        &outside_differing[..outside_differing.len().min(8)]
    );

    // The floor the planner relies on: full depth across the band and its
    // surroundings for the whole probed strip through the middle.
    let mut probed = 0usize;
    for row in 0..map.rows {
        let y = origin_y + row as f64 * step;
        if !(PROBED_APP_Y.0..=PROBED_APP_Y.1).contains(&y) {
            continue;
        }
        for column in 0..map.columns {
            let x = origin_x + column as f64 * step;
            if !(PROBED_APP_X.0..=PROBED_APP_X.1).contains(&x) {
                continue;
            }
            probed += 1;
            assert_eq!(
                map.decoded(row, column),
                FULL_DEPTH_MM,
                "floor at app ({x}, {y}) is not the full {FULL_DEPTH_MM} mm"
            );
        }
    }
    assert!(probed > 5_000, "probed only {probed} floor cells");
    assert_eq!(flat.asset.depth_map.max_depth_mm, FULL_DEPTH_MM);
}
