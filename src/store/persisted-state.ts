import { z } from "zod";
import { findHeightMapAsset } from "../data/enclosures";
import { cellsLibrary } from "../data/library";
import type { ComponentPlacement, PlannerConfig } from "../bindings";

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
  kind: z.enum(["nickel", "fishpaper", "compound", "holder", "outer-wrap"]),
  scope: z.enum(["cell", "series-group", "pack-block"]),
  application: z.enum([
    "radial",
    "axial-ends",
    "between-cells",
    "between-columns",
    "between-rows",
    "between-layers",
    "between-groups",
    "all-faces",
    "floor",
  ]),
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

const placementSchema = z
  .object({
    id: z.string(),
    componentId: z.string(),
    position: z.tuple([z.number(), z.number()]),
    rotationDeg: z.number().optional(),
    tiltDeg: z.number().optional(),
    // Legacy field from before free-angle rotation existed.
    rotationQuarterTurns: z.number().int().optional(),
    dimensionsMm: dimensionsSchema,
  })
  .transform(
    (placement): ComponentPlacement => ({
      id: placement.id,
      componentId: placement.componentId,
      position: placement.position,
      rotationDeg: placement.rotationDeg ?? (placement.rotationQuarterTurns ?? 0) * 90,
      tiltDeg: placement.tiltDeg ?? 0,
      dimensionsMm: placement.dimensionsMm,
    }),
  );

/**
 * localStorage is untrusted input: an older schema, a partial write, or a
 * hand-edited blob must fall back to defaults instead of crashing the first
 * render. References into the bundled libraries are re-checked so a removed
 * cell or enclosure asset cannot linger in a stored project.
 */
export function sanitizePersistedConfig(
  value: unknown,
  legacy: { spacers?: boolean } = {},
): PlannerConfig | undefined {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const config = parsed.data as PlannerConfig;
  if (!cellsLibrary.some((cell) => cell.id === config.pack.cellId)) return undefined;
  const enclosure = config.enclosure;
  if (enclosure.kind === "mesh-heightmap" && !findHeightMapAsset(enclosure.assetId)) {
    return undefined;
  }
  // Projects stored before the holder-wall layer existed: add it and move the
  // old default compound gap into the holder wall instead of stacking both.
  if (!config.pack.toleranceStack.some((layer) => layer.application === "between-layers")) {
    config.pack.toleranceStack.push({
      id: "layer-lift",
      label: "Подъём слоя (staggered)",
      kind: "holder",
      scope: "series-group",
      application: "between-layers",
      thicknessMm: 0,
    });
  }
  if (!config.pack.toleranceStack.some((layer) => layer.application === "floor")) {
    config.pack.toleranceStack.push({
      id: "holder-floor",
      label: "Дно холдера",
      kind: "holder",
      scope: "pack-block",
      application: "floor",
      thicknessMm: 0,
    });
  }
  const hasHolderWall = config.pack.toleranceStack.some(
    (layer) =>
      layer.kind === "holder" &&
      (layer.application === "between-cells" || layer.application === "between-columns"),
  );
  if (!hasHolderWall) {
    const compound = config.pack.toleranceStack.find(
      (layer) => layer.application === "between-cells",
    );
    if (compound && Math.abs(compound.thicknessMm - 0.8) < 1e-9) compound.thicknessMm = 0.2;
    const separator = config.pack.toleranceStack.find(
      (layer) => layer.application === "between-groups",
    );
    if (separator && Math.abs(separator.thicknessMm - 0.5) < 1e-9) separator.thicknessMm = 1.4;
    config.pack.toleranceStack.push({
      id: "holder-wall",
      label: "Стенка холдера",
      kind: "holder",
      scope: "cell",
      application: "between-cells",
      thicknessMm: 1.2,
    });
  }
  // The holder wall used to be a between-cells layer, which also pushed the
  // nested rows of a staggered lattice apart. It now applies along a row only
  // and the nesting gap is its own spacer-wall layer, which the old holder
  // "spacers" switch used to stand in for.
  const stack = config.pack.toleranceStack;
  if (!stack.some((layer) => layer.application === "between-columns")) {
    for (const layer of stack) {
      if (layer.kind === "holder" && layer.application === "between-cells") {
        layer.application = "between-columns";
      }
    }
  }
  if (!stack.some((layer) => layer.application === "between-rows")) {
    const wallIndex = stack.findIndex((layer) => layer.application === "between-columns");
    const wall = stack[wallIndex];
    stack.splice(wallIndex + 1, 0, {
      id: "spacer-wall",
      label: "Стенка спейсера",
      kind: "holder",
      scope: "series-group",
      application: "between-rows",
      thicknessMm: legacy.spacers === false ? 0 : (wall?.thicknessMm ?? 1.2),
    });
  }
  return config;
}

export function sanitizePersistedPlacements(value: unknown): ComponentPlacement[] | undefined {
  const parsed = z.array(placementSchema).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
