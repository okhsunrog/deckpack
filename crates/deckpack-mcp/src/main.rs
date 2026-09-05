//! `deckpack-mcp`: the pack planner as an MCP server over stdio, so an AI
//! agent can sweep configurations, inspect layouts and export holders.

use std::fs;
use std::path::PathBuf;

use deckpack_core::geometry::evaluate_workspace;
use deckpack_core::holder::generate_holder;
use deckpack_core::packing::enumerate_pack_plans;
use deckpack_core::project::{default_config, mesh_enclosure};
use deckpack_core::*;
use deckpack_mesh::{DepthMapOptions, ImportOptions, import_enclosure_stl};
use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::model::{Implementation, ServerCapabilities, ServerInfo};
use rmcp::{
    ErrorData, ServerHandler, ServiceExt, tool, tool_handler, tool_router, transport::stdio,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

const INSTRUCTIONS: &str = "Deckpack plans cylindrical-cell battery packs inside electric-longboard \
enclosures. Start from `default_config`, adjust the PlannerConfig (cell id from `list_cells`, \
series/parallel counts, enclosure from `list_enclosures` or a `--box`-style EnclosureSpec), then call \
`plan_pack` to enumerate and rank layouts. Use `get_plan` for the full cell positions of one layout, \
`evaluate_layout` to check component placements against it, and `generate_holder` to write the \
printable holder STL. All lengths are millimetres; X runs along the deck (tail → nose), Y across, Z up \
with the origin at the enclosure centre.";

#[derive(Clone)]
struct DeckpackServer;

fn invalid(error: impl std::fmt::Display) -> ErrorData {
    ErrorData::invalid_params(error.to_string(), None)
}

fn internal(error: impl std::fmt::Display) -> ErrorData {
    ErrorData::internal_error(error.to_string(), None)
}

fn enumerate(config: &PlannerConfig) -> Result<EnumerationResponse, ErrorData> {
    if !library::cells()
        .iter()
        .any(|cell| cell.id == config.pack.cell_id)
    {
        return Err(invalid(format!(
            "unknown cell `{}`; see list_cells",
            config.pack.cell_id
        )));
    }
    let cell = library::cell(&config.pack.cell_id).clone();
    enumerate_pack_plans(&EnumerationRequest {
        config: config.clone(),
        cell,
    })
    .map_err(invalid)
}

fn find_plan(plans: Vec<PackPlan>, plan_id: &str) -> Result<PackPlan, ErrorData> {
    plans
        .into_iter()
        .find(|plan| plan.id == plan_id)
        .ok_or_else(|| {
            invalid(format!(
                "no layout `{plan_id}` for this config; call plan_pack first"
            ))
        })
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct EnclosureSummary {
    id: String,
    label: String,
    dimensions_mm: Dimensions3D,
    min_depth_mm: f64,
    max_depth_mm: f64,
    usable_volume_l: f64,
    /// EnclosureSpec to paste into a PlannerConfig.
    enclosure: EnclosureSpec,
}

impl From<HeightMapAsset> for EnclosureSummary {
    fn from(asset: HeightMapAsset) -> Self {
        Self {
            enclosure: EnclosureSpec::MeshHeightmap {
                asset_id: asset.id.clone(),
                dimensions_mm: asset.dimensions_mm,
            },
            id: asset.id,
            label: asset.label,
            dimensions_mm: asset.dimensions_mm,
            min_depth_mm: asset.depth_map.min_depth_mm,
            max_depth_mm: asset.depth_map.max_depth_mm,
            usable_volume_l: asset.depth_map.usable_volume_mm3 / 1e6,
        }
    }
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PlanSummary {
    id: String,
    rank: usize,
    packing_mode: PackingMode,
    orientation: Axis,
    stagger_row_axis: Option<Axis>,
    parallel_factors: Grid3,
    series_factors: Grid3,
    anchor: PlacementAnchor,
    bounds: Box3D,
    metrics: LayoutMetrics,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PlanPackResult {
    explored_count: u32,
    feasible_count: usize,
    /// Ranked best-first; truncated to `limit`.
    plans: Vec<PlanSummary>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PlanPackArgs {
    config: PlannerConfig,
    /// Maximum layouts to return (default 20).
    limit: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct GetPlanArgs {
    config: PlannerConfig,
    /// Plan id from `plan_pack`.
    plan_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct EvaluateArgs {
    config: PlannerConfig,
    plan_id: String,
    /// Components placed on the deck; `componentId` from `list_components` or any custom id.
    placements: Vec<ComponentPlacement>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct HolderArgs {
    config: PlannerConfig,
    plan_id: String,
    /// Absolute path of the STL to write.
    output_path: String,
    /// Defaults to HolderOptions::default() (full belts, 0.25 mm clearance).
    options: Option<HolderOptions>,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct HolderResult {
    path: String,
    byte_length: usize,
    pieces: Vec<HolderPieceSummary>,
    thinnest_wall_mm: f64,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ImportArgs {
    /// Absolute path of the STL (open side facing −Z, long side along source Y).
    path: String,
    /// Asset id to register under (default: file stem).
    id: Option<String>,
    label: Option<String>,
    /// Optional path to save the height-map asset JSON for reuse with the CLI.
    save_json_to: Option<String>,
}

#[tool_router]
impl DeckpackServer {
    #[tool(
        description = "Cell library: ids, sleeved dimensions, mass, voltage and capacity.",
        annotations(read_only_hint = true)
    )]
    fn list_cells(&self) -> Json<Vec<CellSpec>> {
        Json(library::cells().to_vec())
    }

    #[tool(
        description = "Component library (ESCs, BMS, antispark, custom blocks) with dimensions.",
        annotations(read_only_hint = true)
    )]
    fn list_components(&self) -> Json<Vec<ComponentSpec>> {
        Json(library::components().to_vec())
    }

    #[tool(
        description = "Profiled enclosures known to this server, each with the EnclosureSpec to use in a config.",
        annotations(read_only_hint = true)
    )]
    fn list_enclosures(&self) -> Json<Vec<EnclosureSummary>> {
        Json(
            assets::list()
                .into_iter()
                .map(EnclosureSummary::from)
                .collect(),
        )
    }

    #[tool(
        description = "The configuration the desktop app starts with (12S3P EVE 50PL in the Spark case). Edit and pass to plan_pack.",
        annotations(read_only_hint = true)
    )]
    fn default_config(&self) -> Json<PlannerConfig> {
        Json(default_config())
    }

    #[tool(
        description = "Enumerate every feasible layout for a PlannerConfig and rank them. Returns summaries; use get_plan for cell positions.",
        annotations(read_only_hint = true)
    )]
    fn plan_pack(
        &self,
        Parameters(args): Parameters<PlanPackArgs>,
    ) -> Result<Json<PlanPackResult>, ErrorData> {
        let response = enumerate(&args.config)?;
        let limit = args.limit.unwrap_or(20);
        Ok(Json(PlanPackResult {
            explored_count: response.explored_count,
            feasible_count: response.plans.len(),
            plans: response
                .plans
                .into_iter()
                .take(limit)
                .enumerate()
                .map(|(index, plan)| PlanSummary {
                    id: plan.id,
                    rank: index + 1,
                    packing_mode: plan.packing_mode,
                    orientation: plan.orientation,
                    stagger_row_axis: plan.stagger_row_axis,
                    parallel_factors: plan.parallel_factors,
                    series_factors: plan.series_factors,
                    anchor: plan.anchor,
                    bounds: plan.bounds,
                    metrics: plan.metrics,
                })
                .collect(),
        }))
    }

    #[tool(
        description = "Full layout (cells, groups, S-chain, service volumes) for a plan id returned by plan_pack.",
        annotations(read_only_hint = true)
    )]
    fn get_plan(
        &self,
        Parameters(args): Parameters<GetPlanArgs>,
    ) -> Result<Json<PackPlan>, ErrorData> {
        let response = enumerate(&args.config)?;
        Ok(Json(find_plan(response.plans, &args.plan_id)?))
    }

    #[tool(
        description = "Check component placements against a layout: collisions with the pack or each other, parts outside the enclosure, free volume.",
        annotations(read_only_hint = true)
    )]
    fn evaluate_layout(
        &self,
        Parameters(args): Parameters<EvaluateArgs>,
    ) -> Result<Json<WorkspaceEvaluation>, ErrorData> {
        let response = enumerate(&args.config)?;
        let plan = find_plan(response.plans, &args.plan_id)?;
        evaluate_workspace(&args.config.enclosure, &plan, &args.placements)
            .map(Json)
            .map_err(invalid)
    }

    #[tool(
        description = "Generate the printable wave-comb holder for a layout and write it as binary STL."
    )]
    fn generate_holder(
        &self,
        Parameters(args): Parameters<HolderArgs>,
    ) -> Result<Json<HolderResult>, ErrorData> {
        let response = enumerate(&args.config)?;
        let plan = find_plan(response.plans, &args.plan_id)?;
        let cell = library::cell(&args.config.pack.cell_id);
        let options = args.options.unwrap_or_default();
        let build = generate_holder(
            &plan,
            cell,
            &args.config.pack.tolerance_stack,
            &args.config.enclosure,
            &options,
        )
        .map_err(invalid)?;
        fs::write(&args.output_path, &build.stl)
            .map_err(|error| internal(format!("cannot write {}: {error}", args.output_path)))?;
        let thinnest = build
            .pieces
            .iter()
            .map(|p| p.min_wall_mm)
            .fold(f64::INFINITY, f64::min);
        Ok(Json(HolderResult {
            path: args.output_path,
            byte_length: build.stl.len(),
            pieces: build.pieces,
            thinnest_wall_mm: thinnest,
        }))
    }

    #[tool(
        description = "Import an enclosure STL: sample its inner surface into a height map and register it for plan_pack."
    )]
    fn import_enclosure(
        &self,
        Parameters(args): Parameters<ImportArgs>,
    ) -> Result<Json<EnclosureSummary>, ErrorData> {
        let path = PathBuf::from(&args.path);
        let bytes = fs::read(&path)
            .map_err(|error| invalid(format!("cannot read {}: {error}", args.path)))?;
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("enclosure")
            .to_owned();
        let imported = import_enclosure_stl(
            &bytes,
            &ImportOptions {
                id: args.id.unwrap_or_else(|| stem.clone()),
                label: args.label.unwrap_or(stem),
                model_url: String::new(),
                depth: DepthMapOptions::default(),
            },
        )
        .map_err(invalid)?;
        if let Some(save) = &args.save_json_to {
            fs::write(save, serde_json::to_vec(&imported.asset).map_err(internal)?)
                .map_err(|error| internal(format!("cannot write {save}: {error}")))?;
        }
        assets::register(imported.asset.clone());
        let _ = mesh_enclosure(&imported.asset.id);
        Ok(Json(EnclosureSummary::from(imported.asset)))
    }
}

#[tool_handler]
impl ServerHandler for DeckpackServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("deckpack", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let service = DeckpackServer.serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
