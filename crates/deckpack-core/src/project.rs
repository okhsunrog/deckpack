//! Project files and the default configuration shared by the app, the CLI
//! and the MCP server.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::assets;
use crate::service::default_service_reservations;
use crate::types::*;

/// Current schema of the exported project JSON (`Экспорт JSON` in the app).
pub const PROJECT_SCHEMA_VERSION: u32 = 2;

pub const SPARK_CASE_ID: &str = "spark-case";

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub schema_version: u32,
    pub config: PlannerConfig,
    #[serde(default)]
    pub components: Vec<ComponentPlacement>,
}

impl ProjectFile {
    pub fn new(config: PlannerConfig, components: Vec<ComponentPlacement>) -> Self {
        Self {
            schema_version: PROJECT_SCHEMA_VERSION,
            config,
            components,
        }
    }
}

fn layer(
    id: &str,
    label: &str,
    kind: ToleranceKind,
    scope: ToleranceScope,
    application: ToleranceApplication,
    thickness_mm: f64,
) -> ToleranceLayer {
    ToleranceLayer {
        id: id.into(),
        label: label.into(),
        kind,
        scope,
        application,
        thickness_mm,
    }
}

/// The tolerance stack a new project starts with.
pub fn default_tolerance_stack() -> Vec<ToleranceLayer> {
    use ToleranceApplication as A;
    use ToleranceKind as K;
    use ToleranceScope as S;
    vec![
        layer(
            "nickel",
            "Nickel at terminals",
            K::Nickel,
            S::Cell,
            A::AxialEnds,
            0.2,
        ),
        layer(
            "fishpaper",
            "Fishpaper around cells",
            K::Fishpaper,
            S::Cell,
            A::Radial,
            0.2,
        ),
        layer(
            "compound",
            "Compound / cell gap",
            K::Compound,
            S::Cell,
            A::BetweenCells,
            0.2,
        ),
        layer(
            "holder-wall",
            "Стенка холдера",
            K::Holder,
            S::Cell,
            A::BetweenCells,
            1.2,
        ),
        layer(
            "layer-lift",
            "Подъём слоя (staggered)",
            K::Holder,
            S::SeriesGroup,
            A::BetweenLayers,
            0.0,
        ),
        layer(
            "holder-floor",
            "Дно холдера",
            K::Holder,
            S::PackBlock,
            A::Floor,
            0.0,
        ),
        layer(
            "group-separator",
            "Group separator",
            K::Fishpaper,
            S::SeriesGroup,
            A::BetweenGroups,
            1.4,
        ),
        layer(
            "outer-wrap",
            "Outer wrap",
            K::OuterWrap,
            S::PackBlock,
            A::AllFaces,
            1.0,
        ),
    ]
}

pub fn box_enclosure(length: f64, width: f64, height: f64) -> EnclosureSpec {
    EnclosureSpec::Box {
        dimensions_mm: Dimensions3D {
            length,
            width,
            height,
        },
    }
}

/// Profiled enclosure for a registered height-map asset.
pub fn mesh_enclosure(asset_id: &str) -> Result<EnclosureSpec, assets::AssetError> {
    assets::with_asset(asset_id, |asset| EnclosureSpec::MeshHeightmap {
        asset_id: asset.id.clone(),
        dimensions_mm: asset.dimensions_mm,
    })
}

/// What the app shows on first launch: 12S3P of EVE 50PL in the Spark case,
/// both lattices allowed, two layers, service reservations off.
pub fn default_config() -> PlannerConfig {
    PlannerConfig {
        enclosure: mesh_enclosure(SPARK_CASE_ID).expect("bundled Spark case asset"),
        pack: PackRequest {
            series_count: 12,
            parallel_count: 3,
            cell_id: "eve-50pl".into(),
            orientation: OrientationRequest::Auto,
            packing_modes: vec![PackingMode::Brick, PackingMode::Staggered],
            max_layers: 2,
            target_center_of_mass_x_mm: 0.0,
            tolerance_stack: default_tolerance_stack(),
            wiring_exit_mode: WiringExitMode::Combined,
            service_reservations: default_service_reservations()
                .into_iter()
                .map(|reservation| ServiceReservation {
                    enabled: false,
                    ..reservation
                })
                .collect(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_matches_the_recorded_app_default() {
        // The first enumerate fixture was recorded from the app's default.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/domain/enumerate/spark-12s3p-default.json");
        let fixture: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let recorded: PlannerConfig =
            serde_json::from_value(fixture["request"]["config"].clone()).unwrap();
        // The holder floor layer was added after the fixtures were recorded.
        let mut config = default_config();
        config
            .pack
            .tolerance_stack
            .retain(|layer| layer.application != ToleranceApplication::Floor);
        assert_eq!(config, recorded);
    }
}
