import { invoke } from "@tauri-apps/api/core";
import type {
  CellSpec,
  EnclosureSpec,
  HolderCsg,
  HolderOptions,
  PackPlan,
  ToleranceLayer,
} from "../bindings";

/** Holder options with every optional field filled in. */
export type HolderSettings = Required<HolderOptions>;

/** Default print options, mirrored from `HolderOptions::default()` in Rust. */
export const DEFAULT_HOLDER_OPTIONS: HolderSettings = {
  clearanceMm: 0.25,
  terminalMarginMm: 7,
  layoutGapMm: 8,
  sampleStepMm: 0.25,
  style: "full",
  edgeStripWidthMm: 12,
  minWallMm: 0.8,
  cap: false,
  spacers: true,
  webMm: 2.5,
  cuspHeight: 1,
};

/**
 * Triangles of the CSG-built holder in enclosure coordinates: the same solids
 * that go to the printer, as a flat `x y z` Float32Array. The command answers
 * with raw bytes, so it is not part of the generated bindings.
 */
export async function fetchHolderMesh(
  plan: PackPlan,
  cell: CellSpec,
  toleranceStack: ToleranceLayer[],
  enclosure: EnclosureSpec,
  options: HolderOptions,
  csg: HolderCsg,
): Promise<Float32Array> {
  const bytes = await invoke<ArrayBuffer>("holder_mesh", {
    plan,
    cell,
    toleranceStack,
    enclosure,
    options,
    csg,
  });
  return new Float32Array(bytes);
}
