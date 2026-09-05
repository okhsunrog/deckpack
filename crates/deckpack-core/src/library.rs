//! Bundled cell and component libraries.
//!
//! The JSON files still live under `src/data` so the TypeScript domain can
//! keep importing them until it is removed; they move next to this crate
//! once Rust is the only consumer.

use std::sync::LazyLock;

use serde::Deserialize;

use crate::types::{CellSpec, ComponentSpec};

const CELLS_JSON: &str = include_str!("../../../src/data/cells.json");
const COMPONENTS_JSON: &str = include_str!("../../../src/data/components.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CellsLibrary {
    schema_version: u32,
    cells: Vec<CellSpec>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComponentsLibrary {
    schema_version: u32,
    components: Vec<ComponentSpec>,
}

static CELLS: LazyLock<Vec<CellSpec>> = LazyLock::new(|| {
    let library: CellsLibrary = serde_json::from_str(CELLS_JSON).expect("cells.json is valid");
    assert_eq!(library.schema_version, 1, "unsupported cells.json schema");
    assert!(
        !library.cells.is_empty(),
        "cells.json must list at least one cell"
    );
    library.cells
});

static COMPONENTS: LazyLock<Vec<ComponentSpec>> = LazyLock::new(|| {
    let library: ComponentsLibrary =
        serde_json::from_str(COMPONENTS_JSON).expect("components.json is valid");
    assert_eq!(
        library.schema_version, 1,
        "unsupported components.json schema"
    );
    library.components
});

pub fn cells() -> &'static [CellSpec] {
    &CELLS
}

pub fn components() -> &'static [ComponentSpec] {
    &COMPONENTS
}

/// Cell by id, falling back to the first library entry like the UI does.
pub fn cell(id: &str) -> &'static CellSpec {
    cells()
        .iter()
        .find(|cell| cell.id == id)
        .unwrap_or(&cells()[0])
}

pub fn component(id: &str) -> Option<&'static ComponentSpec> {
    components().iter().find(|component| component.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn libraries_parse() {
        assert!(cells().iter().any(|cell| cell.id == "eve-50pl"));
        assert!(!components().is_empty());
        assert_eq!(cell("does-not-exist").id, cells()[0].id);
    }
}
