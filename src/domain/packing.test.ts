import { describe, expect, it } from "vite-plus/test";
import { getCell } from "../data/library";
import { defaultConfig } from "../store/planner-store";
import { boxContainmentKernel } from "./geometry";
import { enumeratePackPlans, factorTriples } from "./packing";

describe("factorTriples", () => {
  it("enumerates every ordered integer factorization", () => {
    const factors = factorTriples(12);
    expect(factors).toContainEqual([1, 1, 12]);
    expect(factors).toContainEqual([2, 3, 2]);
    expect(factors).toContainEqual([12, 1, 1]);
    expect(factors.every(([x, y, z]) => x * y * z === 12)).toBe(true);
    expect(new Set(factors.map((item) => item.join("x"))).size).toBe(factors.length);
  });
});

describe("enumeratePackPlans", () => {
  const config = structuredClone(defaultConfig);
  const response = enumeratePackPlans({ config, cell: getCell(config.pack.cellId) });

  it("finds feasible brick and staggered layouts", () => {
    expect(response.exploredCount).toBeGreaterThan(0);
    expect(response.plans.length).toBeGreaterThan(0);
    expect(response.plans.some((plan) => plan.packingMode === "brick")).toBe(true);
    expect(response.plans.some((plan) => plan.packingMode === "staggered")).toBe(true);
  });

  it("preserves the electrical group invariants", () => {
    for (const plan of response.plans) {
      expect(plan.cells).toHaveLength(config.pack.seriesCount * config.pack.parallelCount);
      expect(plan.groups).toHaveLength(config.pack.seriesCount);
      expect(plan.seriesOrder).toHaveLength(config.pack.seriesCount);
      expect(plan.seriesPath).toHaveLength(config.pack.seriesCount);
      expect(new Set(plan.seriesOrder).size).toBe(config.pack.seriesCount);
      for (const group of plan.groups) {
        expect(group.cellIds).toHaveLength(config.pack.parallelCount);
      }
    }
  });

  it("keeps every reservation inside the enclosure", () => {
    for (const plan of response.plans) {
      expect(boxContainmentKernel.contains(config.enclosure, plan.bounds)).toBe(true);
      expect(plan.metrics.layerCount).toBeLessThanOrEqual(config.pack.maxLayers);
      expect(plan.blocks).toHaveLength(1);
      expect(plan.blocks[0].groupIds).toHaveLength(config.pack.seriesCount);
    }
  });

  it("ranks layouts in descending score order", () => {
    for (let index = 1; index < response.plans.length; index += 1) {
      expect(response.plans[index - 1].metrics.score).toBeGreaterThanOrEqual(
        response.plans[index].metrics.score,
      );
    }
  });
});
