import { describe, expect, it } from "vite-plus/test";
import { getCell } from "../data/library";
import { defaultConfig } from "../store/planner-store";
import { generateHolder } from "./holder";
import { enumeratePackPlans } from "./packing";

describe("holder generator", () => {
  const cell = getCell(defaultConfig.pack.cellId);
  const plans = enumeratePackPlans({ config: defaultConfig, cell }).plans;

  it("builds cradles and interlayer spacers for a two-layer staggered plan", () => {
    const plan = plans.find(
      (candidate) => candidate.packingMode === "staggered" && candidate.metrics.layerCount === 2,
    )!;
    const build = generateHolder(plan, cell, defaultConfig.pack.toleranceStack);
    // Two axial rows -> per row one cradle and one spacer.
    expect(build.pieces).toHaveLength(4);
    expect(build.pieces.filter((piece) => piece.label.startsWith("cradle"))).toHaveLength(2);
    expect(build.pieces.filter((piece) => piece.label.startsWith("spacer"))).toHaveLength(2);
    for (const piece of build.pieces) {
      expect(piece.triangleCount).toBeGreaterThan(100);
      // Strip length leaves the terminal ends free for nickel.
      expect(piece.sizeMm[2]).toBeCloseTo(cell.sleevedHeightMm - 14);
    }
    // Binary STL: header + count + 50 bytes per triangle.
    const total = build.pieces.reduce((sum, piece) => sum + piece.triangleCount, 0);
    expect(build.stl.byteLength).toBe(84 + total * 50);
    expect(new DataView(build.stl).getUint32(80, true)).toBe(total);
  });

  it("keeps a printable wall between nested staggered layers", () => {
    const plan = plans.find(
      (candidate) => candidate.packingMode === "staggered" && candidate.metrics.layerCount === 2,
    )!;
    const build = generateHolder(plan, cell, defaultConfig.pack.toleranceStack);
    const spacers = build.pieces.filter((piece) => piece.label.startsWith("spacer"));
    for (const spacer of spacers) {
      // holder wall 1.2 + compound 0.2 minus radial reserve and clearance
      expect(spacer.minWallMm).toBeGreaterThan(0.5);
    }
  });

  it("refuses vertical cells", () => {
    const plan = { ...plans[0], orientation: "z" as const };
    expect(() => generateHolder(plan, cell, defaultConfig.pack.toleranceStack)).toThrow();
  });
});
