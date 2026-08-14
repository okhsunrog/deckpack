import { z } from "zod";
import cellsJson from "./cells.json";
import componentsJson from "./components.json";

const sourceSchema = z.object({
  url: z.string().url(),
  label: z.string(),
  checkedAt: z.string(),
  dimensionBasis: z.string(),
});

const visualAssetSourceSchema = z.object({
  url: z.string().url(),
  creator: z.string(),
  license: z.string(),
  licenseUrl: z.string().url(),
});

const componentVisualSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stl"),
    assetUrl: z.string(),
    rotationDeg: z.tuple([z.number(), z.number(), z.number()]).optional(),
    source: visualAssetSourceSchema,
  }),
  z.object({
    kind: z.literal("top-texture"),
    assetUrl: z.string(),
    bottomAssetUrl: z.string().optional(),
    insetMm: z.number().nonnegative().optional(),
    source: visualAssetSourceSchema,
  }),
  z.object({
    kind: z.literal("procedural"),
    style: z.enum(["finned-case", "sealed-case", "pcb"]),
  }),
]);

const cellSchema = z.object({
  id: z.string(),
  manufacturer: z.string(),
  model: z.string(),
  formFactor: z.literal("21700"),
  chemistry: z.string(),
  sleevedDiameterMm: z.number().positive(),
  sleevedHeightMm: z.number().positive(),
  bareDiameterMm: z.number().positive().optional(),
  bareHeightMm: z.number().positive().optional(),
  massG: z.number().positive(),
  nominalVoltageV: z.number().positive(),
  capacityAh: z.number().positive(),
  source: sourceSchema,
});

const componentSchema = z.object({
  id: z.string(),
  manufacturer: z.string(),
  model: z.string(),
  category: z.enum(["esc", "bms", "antispark", "custom"]),
  dimensionsMm: z.object({
    length: z.number().positive(),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  massG: z.number().positive().optional(),
  color: z.string(),
  source: sourceSchema.optional(),
  visual: componentVisualSchema.optional(),
});

const cellsLibrarySchema = z.object({ schemaVersion: z.literal(1), cells: z.array(cellSchema) });
const componentsLibrarySchema = z.object({
  schemaVersion: z.literal(1),
  components: z.array(componentSchema),
});

export const cellsLibrary = cellsLibrarySchema.parse(cellsJson).cells;
export const componentsLibrary = componentsLibrarySchema.parse(componentsJson).components;

export function getCell(id: string) {
  return cellsLibrary.find((cell) => cell.id === id) ?? cellsLibrary[0];
}

export function getComponent(id: string) {
  return componentsLibrary.find((component) => component.id === id) ?? componentsLibrary[0];
}
