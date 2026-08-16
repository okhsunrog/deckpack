import { describe, expect, it } from "vite-plus/test";
import { getCell } from "../data/library";
import { defaultConfig } from "../store/planner-store";
import { availableDepthForBox } from "./geometry";
import { computeHolderPieces, DEFAULT_HOLDER_OPTIONS, generateHolder } from "./holder";
import { enumeratePackPlans } from "./packing";

describe("holder generator", () => {
  const cell = getCell(defaultConfig.pack.cellId);
  const plans = enumeratePackPlans({ config: defaultConfig, cell }).plans;

  it("builds cradles and interlayer spacers for a two-layer staggered plan", () => {
    const plan = plans.find(
      (candidate) => candidate.packingMode === "staggered" && candidate.metrics.layerCount === 2,
    )!;
    const build = generateHolder(
      plan,
      cell,
      defaultConfig.pack.toleranceStack,
      defaultConfig.enclosure,
    );
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

  it("splits each belt into two edge bands in the edge style", () => {
    const plan = plans.find(
      (candidate) => candidate.packingMode === "staggered" && candidate.metrics.layerCount === 2,
    )!;
    const build = generateHolder(
      plan,
      cell,
      defaultConfig.pack.toleranceStack,
      defaultConfig.enclosure,
      { ...DEFAULT_HOLDER_OPTIONS, style: "edge" },
    );
    // Two rows x (cradle + spacer) x two bands per strip.
    expect(build.pieces).toHaveLength(8);
    expect(build.pieces.filter((piece) => piece.label.startsWith("cradle"))).toHaveLength(4);
    for (const piece of build.pieces) {
      expect(piece.sizeMm[2]).toBeCloseTo(DEFAULT_HOLDER_OPTIONS.edgeStripWidthMm);
      expect(piece.triangleCount).toBeGreaterThan(100);
    }
    // The bands sit inside the covered zone: outer edge at the terminal
    // margin, so welding access is identical to the full belt.
    const layout = computeHolderPieces(
      plan,
      cell,
      defaultConfig.pack.toleranceStack,
      defaultConfig.enclosure,
      { ...DEFAULT_HOLDER_OPTIONS, style: "edge" },
    );
    const halfCovered = cell.sleevedHeightMm / 2 - DEFAULT_HOLDER_OPTIONS.terminalMarginMm;
    const axialIndex = plan.orientation === "x" ? 0 : 1;
    const rows = [...new Set(plan.cells.map((placed) => placed.position[axialIndex]))];
    for (const piece of layout.pieces) {
      const row = rows.reduce((best, candidate) =>
        Math.abs(candidate - piece.axialCenterMm) < Math.abs(best - piece.axialCenterMm)
          ? candidate
          : best,
      );
      const outerEdge = Math.abs(piece.axialCenterMm - row) + piece.lengthMm / 2;
      expect(outerEdge).toBeCloseTo(halfCovered, 5);
    }
  });

  it("keeps a printable wall between nested staggered layers", () => {
    const plan = plans.find(
      (candidate) => candidate.packingMode === "staggered" && candidate.metrics.layerCount === 2,
    )!;
    const build = generateHolder(
      plan,
      cell,
      defaultConfig.pack.toleranceStack,
      defaultConfig.enclosure,
    );
    const spacers = build.pieces.filter((piece) => piece.label.startsWith("spacer"));
    for (const spacer of spacers) {
      // holder wall 1.2 + compound 0.2 minus radial reserve and clearance
      expect(spacer.minWallMm).toBeGreaterThan(0.5);
    }
  });

  it("keeps the cradle underside on or above the case floor", () => {
    const plan = plans.find(
      (candidate) => candidate.packingMode === "staggered" && candidate.metrics.layerCount === 2,
    )!;
    const layout = computeHolderPieces(
      plan,
      cell,
      defaultConfig.pack.toleranceStack,
      defaultConfig.enclosure,
    );
    const topZ = defaultConfig.enclosure.dimensionsMm.height / 2;
    const cradles = layout.pieces.filter((piece) => piece.label.startsWith("cradle"));
    expect(cradles.length).toBeGreaterThan(0);
    for (const cradle of cradles) {
      const axialLo = cradle.axialCenterMm - cradle.lengthMm / 2;
      const axialHi = cradle.axialCenterMm + cradle.lengthMm / 2;
      let follows = false;
      for (let i = 0; i < cradle.t.length; i += 8) {
        // Degenerate columns are trimmed material, not a floor violation.
        if (cradle.top[i] - cradle.bottom[i] < 0.05) continue;
        const t = cradle.t[i];
        const probe =
          layout.axialIndex === 0
            ? { min: [axialLo, t - 0.25, 0] as const, max: [axialHi, t + 0.25, 0] as const }
            : { min: [t - 0.25, axialLo, 0] as const, max: [t + 0.25, axialHi, 0] as const };
        const floorZ =
          topZ -
          availableDepthForBox(defaultConfig.enclosure, {
            min: [...probe.min],
            max: [...probe.max],
          });
        // Never below the real floor...
        expect(cradle.bottom[i]).toBeGreaterThanOrEqual(floorZ - 1e-6);
      }
      // ...and not flat: the pack straddles the ramp, so the underside varies.
      const bottoms = cradle.bottom.filter((_, i) => cradle.top[i] - cradle.bottom[i] > 0.01);
      follows = Math.max(...bottoms) - Math.min(...bottoms) > 0.5;
      expect(follows).toBe(true);
    }
  });

  it("refuses vertical cells", () => {
    const plan = { ...plans[0], orientation: "z" as const };
    expect(() =>
      generateHolder(plan, cell, defaultConfig.pack.toleranceStack, defaultConfig.enclosure),
    ).toThrow();
  });
});
