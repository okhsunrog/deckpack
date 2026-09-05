import { useSyncExternalStore } from "react";
import { commands, type EnclosureSpec, type HeightMapAsset } from "../bindings";
import sparkCaseData from "./enclosures/spark-case-heightmap.json";

export type MeshHeightMapEnclosureSpec = Extract<EnclosureSpec, { kind: "mesh-heightmap" }>;

export const SPARK_CASE_ID = "spark-case";

/**
 * Registry of profiled enclosures: the bundled Spark case plus everything the
 * user imported from STL. The Rust core keeps the authoritative copy; this
 * mirror exists so the UI can render synchronously and react to imports.
 */
let assets: HeightMapAsset[] = [sparkCaseData as unknown as HeightMapAsset];
const listeners = new Set<() => void>();

function publish(next: HeightMapAsset[]): void {
  assets = next;
  listeners.forEach((listener) => listener());
}

export function enclosureAssets(): HeightMapAsset[] {
  return assets;
}

export function useEnclosureAssets(): HeightMapAsset[] {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, enclosureAssets);
}

export function removeEnclosureAsset(id: string): void {
  publish(assets.filter((existing) => existing.id !== id));
}

export function addEnclosureAsset(asset: HeightMapAsset): void {
  publish([...assets.filter((existing) => existing.id !== asset.id), asset]);
}

/** Pull the full list (bundled + imported) from the core. Call before rendering. */
export async function loadEnclosureAssets(): Promise<void> {
  const fromCore = await commands.enclosureAssets();
  const merged = [...assets];
  for (const asset of fromCore) {
    const index = merged.findIndex((existing) => existing.id === asset.id);
    if (index >= 0) merged[index] = asset;
    else merged.push(asset);
  }
  publish(merged);
}

export function findHeightMapAsset(id: string): HeightMapAsset | undefined {
  return assets.find((asset) => asset.id === id);
}

export function getHeightMapAsset(enclosure: MeshHeightMapEnclosureSpec): HeightMapAsset {
  const asset = findHeightMapAsset(enclosure.assetId);
  if (!asset) throw new Error(`Unknown enclosure asset: ${enclosure.assetId}`);
  return asset;
}

export function createMeshEnclosure(assetId: string): MeshHeightMapEnclosureSpec {
  const asset = findHeightMapAsset(assetId) ?? assets[0];
  return { kind: "mesh-heightmap", assetId: asset.id, dimensionsMm: { ...asset.dimensionsMm } };
}

export function createSparkCaseEnclosure(): MeshHeightMapEnclosureSpec {
  return createMeshEnclosure(SPARK_CASE_ID);
}
