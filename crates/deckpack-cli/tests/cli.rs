use std::path::Path;
use std::process::Command;

fn deckpack() -> Command {
    Command::new(env!("CARGO_BIN_EXE_deckpack"))
}

fn stdout(command: &mut Command) -> String {
    let output = command.output().expect("run deckpack");
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn plan_prints_the_default_project_summary() {
    let text = stdout(deckpack().args(["plan", "--limit", "1"]));
    assert!(
        text.contains("12S3P × INR21700/50PL in spark-case"),
        "{text}"
    );
    assert!(text.contains("534 explored, 2 fit"), "{text}");
    assert!(text.contains("layout-1-462436801"), "{text}");
}

#[test]
fn plan_json_is_an_enumeration_response() {
    let text = stdout(deckpack().args(["plan", "--box", "800x210x34", "-p", "4", "--json"]));
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["exploredCount"], 18);
    assert_eq!(value["plans"].as_array().unwrap().len(), 18);
}

#[test]
fn holder_writes_a_binary_stl() {
    let dir = std::env::temp_dir().join(format!("deckpack-cli-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let out = dir.join("holder.stl");
    let text = stdout(deckpack().args(["holder", "-o", out.to_str().unwrap()]));
    assert!(text.contains("4 pieces"), "{text}");
    let bytes = std::fs::read(&out).unwrap();
    let count = u32::from_le_bytes(bytes[80..84].try_into().unwrap()) as usize;
    assert_eq!(bytes.len(), 84 + count * 50);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn enclosure_import_round_trips_into_plan() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let stl = root.join("assets/enclosures/spark-case/source/full-2mm.stl");
    let dir = std::env::temp_dir().join(format!("deckpack-cli-import-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let json = dir.join("case.json");
    let text = stdout(deckpack().args([
        "enclosure",
        "import",
        stl.to_str().unwrap(),
        "-o",
        json.to_str().unwrap(),
        "--id",
        "cli-case",
    ]));
    assert!(text.contains("680 × 426"), "{text}");
    let text = stdout(deckpack().args([
        "plan",
        "--enclosure-file",
        json.to_str().unwrap(),
        "--limit",
        "1",
    ]));
    assert!(text.contains("in cli-case"), "{text}");
    assert!(text.contains("2 fit"), "{text}");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn unknown_cell_is_rejected() {
    let output = deckpack()
        .args(["plan", "--cell", "nope"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("unknown cell"));
}
