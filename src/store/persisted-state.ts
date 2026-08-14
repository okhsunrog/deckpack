import { z } from "zod";
import { enclosureAssets } from "../data/enclosures";
import { cellsLibrary } from "../data/library";
import type { ComponentPlacement, PlannerConfig } from "../domain/types";

const vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

const dimensionsSchema = z.object({
  length: z.number().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
});

const enclosureSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("box"), dimensionsMm: dimensionsSchema }),
  z.object({
    kind: z.literal("mesh-heightmap"),
    assetId: z.string(),
    dimensionsMm: dimensionsSchema,
  }),
]);

const toleranceLayerSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["nickel", "fishpaper", "compound", "outer-wrap"]),
  scope: z.enum(["cell", "series-group", "pack-block"]),
  application: z.enum(["radial", "axial-ends", "between-cells", "between-groups", "all-faces"]),
  thicknessMm: z.number().nonnegative(),
});

const serviceReservationSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["wiring-exit", "balance-harness", "power-output"]),
  face: z.enum(["positive-x", "negative-x", "positive-y", "negative-y"]),
  sizeMm: vec3Schema,
  offsetMm: vec3Schema.optional(),
  enabled: z.boolean(),
});

const packSchema = z.object({
  seriesCount: z.number().int().min(1).max(64),
  parallelCount: z.number().int().min(1).max(32),
  cellId: z.string(),
  orientation: z.enum(["auto", "x", "y", "z"]),
  packingModes: z.array(z.enum(["brick", "staggered"])).min(1),
  maxLayers: z.number().int().min(1).max(8),
  targetCenterOfMassXmm: z.number(),
  toleranceStack: z.array(toleranceLayerSchema),
  wiringExitMode: z.enum(["combined", "separate"]),
  serviceReservations: z.array(serviceReservationSchema),
});

const configSchema = z.object({ enclosure: enclosureSchema, pack: packSchema });

const placementSchema = z.object({
  id: z.string(),
  componentId: z.string(),
  position: z.tuple([z.number(), z.number()]),
  rotationQuarterTurns: z.number().int(),
  dimensionsMm: dimensionsSchema,
});

/**
 * localStorage is untrusted input: an older schema, a partial write, or a
 * hand-edited blob must fall back to defaults instead of crashing the first
 * render. References into the bundled libraries are re-checked so a removed
 * cell or enclosure asset cannot linger in a stored project.
 */
export function sanitizePersistedConfig(value: unknown): PlannerConfig | undefined {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const config = parsed.data as PlannerConfig;
  if (!cellsLibrary.some((cell) => cell.id === config.pack.cellId)) return undefined;
  const enclosure = config.enclosure;
  if (
    enclosure.kind === "mesh-heightmap" &&
    !enclosureAssets.some((asset) => asset.id === enclosure.assetId)
  ) {
    return undefined;
  }
  return config;
}

export function sanitizePersistedPlacements(value: unknown): ComponentPlacement[] | undefined {
  const parsed = z.array(placementSchema).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
