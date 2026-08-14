import sparkCaseData from "./enclosures/spark-case-heightmap.json";
import type { Dimensions3D, MeshHeightMapEnclosureSpec } from "../domain/types";

export interface HeightMapAsset {
  id: string;
  label: string;
  kind: "mesh-heightmap";
  dimensionsMm: Dimensions3D;
  modelUrl: string;
  meshTriangles: number;
  depthMap: {
    originMm: [number, number];
    stepMm: number;
    columns: number;
    rows: number;
    depthQuantizationMm: number;
    safetyMarginMm: number;
    minDepthMm: number;
    maxDepthMm: number;
    usableVolumeMm3: number;
    dataBase64: string;
  };
}

export const sparkCaseAsset = sparkCaseData as HeightMapAsset;
export const enclosureAssets = [sparkCaseAsset];

/** Register an additional asset (used by tests to probe synthetic profiles). */
export function registerEnclosureAsset(asset: HeightMapAsset): void {
  if (!enclosureAssets.some((existing) => existing.id === asset.id)) {
    enclosureAssets.push(asset);
  }
}

export function createSparkCaseEnclosure(): MeshHeightMapEnclosureSpec {
  return {
    kind: "mesh-heightmap",
    assetId: sparkCaseAsset.id,
    dimensionsMm: { ...sparkCaseAsset.dimensionsMm },
  };
}

export function getHeightMapAsset(enclosure: MeshHeightMapEnclosureSpec): HeightMapAsset {
  const asset = enclosureAssets.find((candidate) => candidate.id === enclosure.assetId);
  if (!asset) throw new Error(`Unknown enclosure asset: ${enclosure.assetId}`);
  return asset;
}
