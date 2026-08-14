export type Vec3 = [number, number, number];
export type Axis = "x" | "y" | "z";
export type CellOrientation = Axis;
export type PackingMode = "brick" | "staggered";
export type PlacementAnchor = "tail" | "center" | "nose" | "profile";

export interface Dimensions3D {
  length: number;
  width: number;
  height: number;
}

export interface Box3D {
  min: Vec3;
  max: Vec3;
}

export interface SourceMetadata {
  url: string;
  label: string;
  checkedAt: string;
  dimensionBasis: string;
}

export interface VisualAssetSource {
  url: string;
  creator: string;
  license: string;
  licenseUrl: string;
}

export type ComponentVisual =
  | {
      kind: "stl";
      assetUrl: string;
      rotationDeg?: Vec3;
      source: VisualAssetSource;
    }
  | {
      kind: "top-texture";
      assetUrl: string;
      insetMm?: number;
      source: VisualAssetSource;
    }
  | {
      kind: "procedural";
      style: "finned-case" | "sealed-case" | "pcb";
    };

export interface CellSpec {
  id: string;
  manufacturer: string;
  model: string;
  formFactor: "21700";
  chemistry: string;
  sleevedDiameterMm: number;
  sleevedHeightMm: number;
  bareDiameterMm?: number;
  bareHeightMm?: number;
  massG: number;
  nominalVoltageV: number;
  capacityAh: number;
  source: SourceMetadata;
}

export type ToleranceKind = "nickel" | "fishpaper" | "compound" | "outer-wrap";
export type ToleranceScope = "cell" | "series-group" | "pack-block";
export type ToleranceApplication =
  | "radial"
  | "axial-ends"
  | "between-cells"
  | "between-groups"
  | "all-faces";

export interface ToleranceLayer {
  id: string;
  label: string;
  kind: ToleranceKind;
  scope: ToleranceScope;
  application: ToleranceApplication;
  thicknessMm: number;
}

export type PackFace = "positive-x" | "negative-x" | "positive-y" | "negative-y";
export type WiringExitMode = "combined" | "separate";

export interface ServiceReservation {
  id: string;
  label: string;
  kind: "wiring-exit" | "balance-harness" | "power-output";
  face: PackFace;
  sizeMm: Vec3;
  offsetMm?: Vec3;
  enabled: boolean;
}

export interface BoxEnclosureSpec {
  kind: "box";
  dimensionsMm: Dimensions3D;
}

export interface MeshHeightMapEnclosureSpec {
  kind: "mesh-heightmap";
  assetId: string;
  dimensionsMm: Dimensions3D;
}

export type EnclosureSpec = BoxEnclosureSpec | MeshHeightMapEnclosureSpec;

export interface PackRequest {
  seriesCount: number;
  parallelCount: number;
  cellId: string;
  orientation: "auto" | CellOrientation;
  packingModes: PackingMode[];
  maxLayers: number;
  targetCenterOfMassXmm: number;
  toleranceStack: ToleranceLayer[];
  wiringExitMode: WiringExitMode;
  serviceReservations: ServiceReservation[];
}

export interface PlannerConfig {
  enclosure: EnclosureSpec;
  pack: PackRequest;
}

export interface CellPlacement {
  id: string;
  groupId: string;
  seriesIndex: number;
  position: Vec3;
}

export interface SeriesGroup {
  id: string;
  seriesIndex: number;
  grid: Vec3;
  center: Vec3;
  cellIds: string[];
}

export interface PackBlock {
  id: string;
  groupIds: string[];
  envelope: Box3D;
}

export interface ServiceVolume {
  id: string;
  label: string;
  kind: ServiceReservation["kind"];
  box: Box3D;
}

export interface LargestFreeBox {
  box: Box3D;
  volumeMm3: number;
}

export interface LayoutMetrics {
  score: number;
  centerOfMassXmm: number;
  centerOfMassPercent: number;
  centerOffsetMm: number;
  seriesChainLengthMm: number;
  minClearanceMm: number;
  layerCount: number;
  reservationVolumeMm3: number;
  utilizationPercent: number;
  largestFreeBox: LargestFreeBox;
  manufacturability: number;
}

export interface PackPlan {
  id: string;
  packingMode: PackingMode;
  orientation: CellOrientation;
  staggerRowAxis?: Axis;
  parallelFactors: Vec3;
  seriesFactors: Vec3;
  anchor: PlacementAnchor;
  cellSizeMm: Vec3;
  cells: CellPlacement[];
  groups: SeriesGroup[];
  seriesOrder: string[];
  seriesPath: Vec3[];
  blocks: PackBlock[];
  serviceVolumes: ServiceVolume[];
  bounds: Box3D;
  metrics: LayoutMetrics;
}

export type ComponentCategory = "esc" | "bms" | "antispark" | "custom";

export interface ComponentSpec {
  id: string;
  manufacturer: string;
  model: string;
  category: ComponentCategory;
  dimensionsMm: Dimensions3D;
  massG?: number;
  color: string;
  source?: SourceMetadata;
  visual?: ComponentVisual;
}

export interface ComponentPlacement {
  id: string;
  componentId: string;
  position: [number, number];
  rotationQuarterTurns: number;
  dimensionsMm: Dimensions3D;
}

export interface ComponentEvaluation {
  id: string;
  box: Box3D;
  collides: boolean;
  outside: boolean;
}

export interface WorkspaceEvaluation {
  components: ComponentEvaluation[];
  hasCollision: boolean;
  freeVolumeMm3: number;
  freePercent: number;
  largestFreeBox: LargestFreeBox;
}

export interface EnumerationRequest {
  config: PlannerConfig;
  cell: CellSpec;
}

export interface EnumerationResponse {
  plans: PackPlan[];
  exploredCount: number;
}
