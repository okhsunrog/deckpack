//! Domain data model shared with the frontend.
//!
//! Serialisation mirrors the JSON the React app already speaks (camelCase
//! fields, kebab-case string enums, `kind`-tagged unions); the TypeScript
//! declarations are generated from these types by `tauri-specta`.
//!
//! Optional fields serialise as `null` rather than being omitted: specta's
//! unified type mode cannot express conditional omission, and the frontend
//! treats `null` and `undefined` alike.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

/// Millimetre coordinates: X along the deck (tail → nose), Y across, Z up.
pub type Vec3 = [f64; 3];
/// Integer grid triple (cells per axis).
pub type Grid3 = [u32; 3];

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    X,
    Y,
    Z,
}

impl Axis {
    pub const ALL: [Axis; 3] = [Axis::X, Axis::Y, Axis::Z];

    pub fn index(self) -> usize {
        match self {
            Axis::X => 0,
            Axis::Y => 1,
            Axis::Z => 2,
        }
    }
}

pub type CellOrientation = Axis;

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum PackingMode {
    Brick,
    Staggered,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum PlacementAnchor {
    Tail,
    Center,
    Nose,
    Profile,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Dimensions3D {
    pub length: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Box3D {
    pub min: Vec3,
    pub max: Vec3,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceMetadata {
    pub url: String,
    pub label: String,
    pub checked_at: String,
    pub dimension_basis: String,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VisualAssetSource {
    pub url: String,
    pub creator: String,
    pub license: String,
    pub license_url: String,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProceduralStyle {
    FinnedCase,
    SealedCase,
    Pcb,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ComponentVisual {
    Stl {
        asset_url: String,
        #[serde(default)]
        #[specta(optional)]
        rotation_deg: Option<Vec3>,
        source: VisualAssetSource,
    },
    TopTexture {
        asset_url: String,
        /// Optional photo for the underside (e.g. a bottom-mounted heatsink).
        #[serde(default)]
        #[specta(optional)]
        bottom_asset_url: Option<String>,
        #[serde(default)]
        #[specta(optional)]
        inset_mm: Option<f64>,
        source: VisualAssetSource,
    },
    Procedural {
        style: ProceduralStyle,
    },
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
pub enum CellFormFactor {
    #[serde(rename = "21700")]
    Cyl21700,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CellSpec {
    pub id: String,
    pub manufacturer: String,
    pub model: String,
    pub form_factor: CellFormFactor,
    pub chemistry: String,
    pub sleeved_diameter_mm: f64,
    pub sleeved_height_mm: f64,
    #[serde(default)]
    #[specta(optional)]
    pub bare_diameter_mm: Option<f64>,
    #[serde(default)]
    #[specta(optional)]
    pub bare_height_mm: Option<f64>,
    pub mass_g: f64,
    pub nominal_voltage_v: f64,
    pub capacity_ah: f64,
    pub source: SourceMetadata,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum ToleranceKind {
    Nickel,
    Fishpaper,
    Compound,
    Holder,
    OuterWrap,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum ToleranceScope {
    Cell,
    SeriesGroup,
    PackBlock,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum ToleranceApplication {
    Radial,
    AxialEnds,
    /// Material between every pair of neighbouring cells, whatever direction
    /// they touch in: along a row, stacked in a brick grid, or nested
    /// diagonally between staggered rows (compound, glue gap).
    BetweenCells,
    /// Material between neighbours of the same row or brick grid only, e.g.
    /// the cradle wall of a printed holder. Nested staggered rows do not see
    /// it: they touch through `BetweenCells` and `BetweenRows`.
    BetweenColumns,
    /// Material between the nested cells of adjacent staggered rows only,
    /// e.g. the web of an interlayer spacer. At 0 the upper row rests
    /// directly in the valleys of the lower one.
    BetweenRows,
    /// Extra vertical lift of every staggered row on top of the nesting pitch.
    BetweenLayers,
    BetweenGroups,
    AllFaces,
    /// Material under the whole pack, e.g. the base of a printed holder.
    Floor,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToleranceLayer {
    pub id: String,
    pub label: String,
    pub kind: ToleranceKind,
    pub scope: ToleranceScope,
    pub application: ToleranceApplication,
    pub thickness_mm: f64,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum PackFace {
    PositiveX,
    NegativeX,
    PositiveY,
    NegativeY,
}

impl PackFace {
    /// Axis the face is perpendicular to.
    pub fn axis(self) -> Axis {
        match self {
            PackFace::PositiveX | PackFace::NegativeX => Axis::X,
            PackFace::PositiveY | PackFace::NegativeY => Axis::Y,
        }
    }

    /// +1 for positive faces, -1 for negative ones.
    pub fn sign(self) -> f64 {
        match self {
            PackFace::PositiveX | PackFace::PositiveY => 1.0,
            PackFace::NegativeX | PackFace::NegativeY => -1.0,
        }
    }
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum WiringExitMode {
    Combined,
    Separate,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum ServiceKind {
    WiringExit,
    BalanceHarness,
    PowerOutput,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceReservation {
    pub id: String,
    pub label: String,
    pub kind: ServiceKind,
    pub face: PackFace,
    pub size_mm: Vec3,
    #[serde(default)]
    #[specta(optional)]
    pub offset_mm: Option<Vec3>,
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum EnclosureSpec {
    Box {
        dimensions_mm: Dimensions3D,
    },
    MeshHeightmap {
        asset_id: String,
        dimensions_mm: Dimensions3D,
    },
}

impl EnclosureSpec {
    pub fn dimensions_mm(&self) -> &Dimensions3D {
        match self {
            EnclosureSpec::Box { dimensions_mm }
            | EnclosureSpec::MeshHeightmap { dimensions_mm, .. } => dimensions_mm,
        }
    }
}

/// Cell axis requested by the user: a fixed axis or let the planner pick.
#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum OrientationRequest {
    Auto,
    X,
    Y,
    Z,
}

impl OrientationRequest {
    pub fn axes(self) -> &'static [Axis] {
        match self {
            OrientationRequest::Auto => &Axis::ALL,
            OrientationRequest::X => &[Axis::X],
            OrientationRequest::Y => &[Axis::Y],
            OrientationRequest::Z => &[Axis::Z],
        }
    }
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackRequest {
    pub series_count: u32,
    pub parallel_count: u32,
    pub cell_id: String,
    pub orientation: OrientationRequest,
    pub packing_modes: Vec<PackingMode>,
    pub max_layers: u32,
    #[serde(rename = "targetCenterOfMassXmm")]
    pub target_center_of_mass_x_mm: f64,
    pub tolerance_stack: Vec<ToleranceLayer>,
    pub wiring_exit_mode: WiringExitMode,
    pub service_reservations: Vec<ServiceReservation>,
    /// Loose staggered lattices only: slide an end cell of the bottom row
    /// that a ramp lifted outward along the ramp until the upper cell resting
    /// on it comes down level with the rest of its row.
    #[serde(default)]
    pub level_upper_rows: bool,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlannerConfig {
    pub enclosure: EnclosureSpec,
    pub pack: PackRequest,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CellPlacement {
    pub id: String,
    pub group_id: String,
    pub series_index: u32,
    /// Lattice layer the cell belongs to; independent of its settled height.
    pub layer: u32,
    pub position: Vec3,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SeriesGroup {
    pub id: String,
    pub series_index: u32,
    pub grid: Grid3,
    pub center: Vec3,
    pub cell_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackBlock {
    pub id: String,
    pub group_ids: Vec<String>,
    pub envelope: Box3D,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceVolume {
    pub id: String,
    pub label: String,
    pub kind: ServiceKind,
    #[serde(rename = "box")]
    pub box_: Box3D,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LargestFreeBox {
    #[serde(rename = "box")]
    pub box_: Box3D,
    pub volume_mm3: f64,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutMetrics {
    pub score: f64,
    #[serde(rename = "centerOfMassXmm")]
    pub center_of_mass_x_mm: f64,
    pub center_of_mass_percent: f64,
    pub center_offset_mm: f64,
    pub series_chain_length_mm: f64,
    pub min_clearance_mm: f64,
    pub layer_count: u32,
    pub reservation_volume_mm3: f64,
    pub utilization_percent: f64,
    pub largest_free_box: LargestFreeBox,
    pub manufacturability: f64,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackPlan {
    pub id: String,
    pub packing_mode: PackingMode,
    pub orientation: CellOrientation,
    #[serde(default)]
    #[specta(optional)]
    pub stagger_row_axis: Option<Axis>,
    pub parallel_factors: Grid3,
    pub series_factors: Grid3,
    pub anchor: PlacementAnchor,
    pub cell_size_mm: Vec3,
    pub cells: Vec<CellPlacement>,
    pub groups: Vec<SeriesGroup>,
    pub series_order: Vec<String>,
    pub series_path: Vec<Vec3>,
    pub blocks: Vec<PackBlock>,
    pub service_volumes: Vec<ServiceVolume>,
    pub bounds: Box3D,
    pub metrics: LayoutMetrics,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum ComponentCategory {
    Esc,
    Bms,
    Antispark,
    Custom,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComponentSpec {
    pub id: String,
    pub manufacturer: String,
    pub model: String,
    pub category: ComponentCategory,
    pub dimensions_mm: Dimensions3D,
    #[serde(default)]
    #[specta(optional)]
    pub mass_g: Option<f64>,
    pub color: String,
    #[serde(default)]
    #[specta(optional)]
    pub source: Option<SourceMetadata>,
    #[serde(default)]
    #[specta(optional)]
    pub visual: Option<ComponentVisual>,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComponentPlacement {
    pub id: String,
    pub component_id: String,
    pub position: [f64; 2],
    /// Yaw around Z in degrees; any angle, not just quarter turns.
    pub rotation_deg: f64,
    /// Pitch around the component's width axis in degrees, applied before
    /// yaw. Positive tilts the +length end down, e.g. to lay a board along a
    /// ramp.
    pub tilt_deg: f64,
    pub dimensions_mm: Dimensions3D,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComponentEvaluation {
    pub id: String,
    #[serde(rename = "box")]
    pub box_: Box3D,
    pub collides: bool,
    pub outside: bool,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEvaluation {
    pub components: Vec<ComponentEvaluation>,
    pub has_collision: bool,
    pub free_volume_mm3: f64,
    pub free_percent: f64,
    pub largest_free_box: LargestFreeBox,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnumerationRequest {
    pub config: PlannerConfig,
    pub cell: CellSpec,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnumerationResponse {
    pub plans: Vec<PackPlan>,
    pub explored_count: u32,
}

/* ------------------------------------------------------------- holders */

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum HolderStyle {
    /// One wide belt per row holds the cells at mid-length.
    Full,
    /// Narrow bands near each cell end, like commercial modular holders.
    Edge,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HolderOptions {
    /// Extra radius on top of the reserved cell radius so cells drop in.
    pub clearance_mm: f64,
    /// Cylinder length left uncovered at each cell end for nickel strips.
    pub terminal_margin_mm: f64,
    /// Gap between laid-out pieces on the plate.
    pub layout_gap_mm: f64,
    /// Profile sampling step along the lateral axis.
    pub sample_step_mm: f64,
    pub style: HolderStyle,
    /// Band width along the cell axis for the "edge" style.
    pub edge_strip_width_mm: f64,
    /// Thinnest wall the printer can make: cusps between bores are flattened
    /// and end slivers trimmed to this width. 0 disables (legacy profiles).
    #[serde(default)]
    pub min_wall_mm: f64,
    /// Also emit a cap over the top layer (wave underneath, flat top), so a
    /// cradle / spacer / cap sandwich can be screwed together through rails.
    #[serde(default)]
    pub cap: bool,
    /// Emit interlayer spacers. With no layer lift the upper cells already nest
    /// in the valleys of the lower ones, so spacers only fill the wedges.
    #[serde(default = "default_true")]
    pub spacers: bool,
    /// Thickness of the thin web that bridges stretches without a cell.
    #[serde(default = "default_web_mm")]
    pub web_mm: f64,
    /// How far the cradle cusps rise between cells, as a fraction of the bore
    /// radius: 1 reaches the cell centre line, 0.6 saves plastic while still
    /// locating the cells.
    #[serde(default = "default_cusp_height")]
    pub cusp_height: f64,
}

fn default_true() -> bool {
    true
}

fn default_web_mm() -> f64 {
    2.5
}

fn default_cusp_height() -> f64 {
    1.0
}

impl Default for HolderOptions {
    fn default() -> Self {
        Self {
            clearance_mm: 0.25,
            terminal_margin_mm: 7.0,
            layout_gap_mm: 8.0,
            sample_step_mm: 0.25,
            style: HolderStyle::Full,
            edge_strip_width_mm: 12.0,
            min_wall_mm: 0.8,
            cap: false,
            spacers: true,
            web_mm: 2.5,
            cusp_height: 1.0,
        }
    }
}

/// One printable comb: a wave profile in the (lateral, z) plane extruded
/// along the cell axis.
#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePiece {
    pub label: String,
    /// Sampled lateral coordinates.
    pub t: Vec<f64>,
    pub top: Vec<f64>,
    pub bottom: Vec<f64>,
    /// Extrusion length along the cell axis.
    pub length_mm: f64,
    /// Axial center of the cell row this piece belongs to.
    pub axial_center_mm: f64,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HolderPieces {
    pub pieces: Vec<ProfilePiece>,
    pub axial_index: u8,
    pub lateral_index: u8,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HolderPieceSummary {
    pub label: String,
    pub triangle_count: u32,
    pub size_mm: Vec3,
    pub min_wall_mm: f64,
}

/* -------------------------------------------------------------- assets */

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DepthMap {
    pub origin_mm: [f64; 2],
    pub step_mm: f64,
    pub columns: u32,
    pub rows: u32,
    pub depth_quantization_mm: f64,
    pub safety_margin_mm: f64,
    pub min_depth_mm: f64,
    pub max_depth_mm: f64,
    pub usable_volume_mm3: f64,
    /// Row-major `columns × rows` u8 depths in quantisation units, base64.
    pub data_base64: String,
}

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HeightMapKind {
    MeshHeightmap,
}

/// Sampled inner surface of an enclosure, generated from its STL.
#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeightMapAsset {
    pub id: String,
    pub label: String,
    pub kind: HeightMapKind,
    pub dimensions_mm: Dimensions3D,
    /// URL of the display mesh for bundled assets (served from `public/`).
    pub model_url: String,
    /// Absolute path of the display mesh for assets imported at runtime; the
    /// frontend turns it into an asset-protocol URL.
    #[serde(default)]
    #[specta(optional)]
    pub model_path: Option<String>,
    pub mesh_triangles: u32,
    pub depth_map: DepthMap,
}
