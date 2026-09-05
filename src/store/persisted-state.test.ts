import { describe, expect, it } from "vite-plus/test";
import { sanitizePersistedConfig } from "./persisted-state";

const baseConfig = {
  enclosure: { kind: "box", dimensionsMm: { length: 800, width: 210, height: 34 } },
  pack: {
    seriesCount: 12,
    parallelCount: 3,
    cellId: "eve-50pl",
    orientation: "auto",
    packingModes: ["brick", "staggered"],
    maxLayers: 2,
    targetCenterOfMassXmm: 0,
    wiringExitMode: "combined",
    serviceReservations: [],
    toleranceStack: [] as unknown[],
  },
};

function layer(id: string, kind: string, application: string, thicknessMm: number) {
  return { id, label: id, kind, scope: "cell", application, thicknessMm };
}

/** The stack a project stored before the spacer-wall layer existed. */
const legacyStack = [
  layer("nickel", "nickel", "axial-ends", 0.2),
  layer("fishpaper", "fishpaper", "radial", 0.2),
  layer("compound", "compound", "between-cells", 0.2),
  layer("holder-wall", "holder", "between-cells", 1.2),
  layer("layer-lift", "holder", "between-layers", 0),
  layer("holder-floor", "holder", "floor", 0),
  layer("group-separator", "fishpaper", "between-groups", 1.4),
  layer("outer-wrap", "outer-wrap", "all-faces", 1),
];

function summary(config: ReturnType<typeof sanitizePersistedConfig>) {
  return config!.pack.toleranceStack.map((l) => [l.id, l.application, l.thicknessMm]);
}

describe("sanitizePersistedConfig tolerance migration", () => {
  it("moves the holder wall to between-columns and adds a spacer wall", () => {
    const config = sanitizePersistedConfig({
      ...baseConfig,
      pack: { ...baseConfig.pack, toleranceStack: legacyStack },
    });
    expect(summary(config)).toEqual([
      ["nickel", "axial-ends", 0.2],
      ["fishpaper", "radial", 0.2],
      ["compound", "between-cells", 0.2],
      ["holder-wall", "between-columns", 1.2],
      ["spacer-wall", "between-rows", 1.2],
      ["layer-lift", "between-layers", 0],
      ["holder-floor", "floor", 0],
      ["group-separator", "between-groups", 1.4],
      ["outer-wrap", "all-faces", 1],
    ]);
  });

  it("honours a stored holder 'spacers: false' switch", () => {
    const config = sanitizePersistedConfig(
      { ...baseConfig, pack: { ...baseConfig.pack, toleranceStack: legacyStack } },
      { spacers: false },
    );
    expect(config!.pack.toleranceStack.find((l) => l.id === "spacer-wall")?.thicknessMm).toBe(0);
  });

  it("is idempotent: a migrated stack is left alone", () => {
    const once = sanitizePersistedConfig({
      ...baseConfig,
      pack: { ...baseConfig.pack, toleranceStack: legacyStack },
    });
    const twice = sanitizePersistedConfig(structuredClone(once));
    expect(summary(twice)).toEqual(summary(once));
    expect(twice!.pack.toleranceStack.filter((l) => l.id === "holder-wall")).toHaveLength(1);
  });
});
