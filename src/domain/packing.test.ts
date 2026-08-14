import { describe, expect, it } from "vite-plus/test";
import { getCell } from "../data/library";
import { defaultConfig } from "../store/planner-store";
import { boxCenter, boxContainmentKernel, boxesIntersect, boxSize } from "./geometry";
import { enumeratePackPlans, factorTriples } from "./packing";
import { setWiringExitMode } from "./service-reservations";

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
      expect(plan.serviceVolumes).toHaveLength(1);
      expect(plan.serviceVolumes[0].kind).toBe("wiring-exit");
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

  it("keeps a mouse-edited service offset relative to its pack face", () => {
    const offsetConfig = structuredClone(defaultConfig);
    const wiringExit = offsetConfig.pack.serviceReservations.find(
      (reservation) => reservation.kind === "wiring-exit",
    )!;
    wiringExit.face = "positive-y";
    wiringExit.offsetMm = [8, 6, 2];
    const plan = enumeratePackPlans({
      config: offsetConfig,
      cell: getCell(offsetConfig.pack.cellId),
    }).plans[0];
    const volume = plan.serviceVolumes.find((item) => item.id === wiringExit.id)!;
    const block = plan.blocks[0].envelope;
    const center = boxCenter(volume.box);
    const blockCenter = boxCenter(block);
    const size = boxSize(volume.box);

    expect(center[0] - blockCenter[0]).toBeCloseTo(8);
    expect(center[1] - block.max[1] - size[1] / 2).toBeCloseTo(6);
    expect(center[2] - blockCenter[2]).toBeCloseTo(2);
  });

  it("starts advanced separate exits beside each other instead of overlapping", () => {
    const separateConfig = structuredClone(defaultConfig);
    separateConfig.pack = setWiringExitMode(separateConfig.pack, "separate");
    const plan = enumeratePackPlans({
      config: separateConfig,
      cell: getCell(separateConfig.pack.cellId),
    }).plans[0];

    expect(plan.serviceVolumes).toHaveLength(2);
    expect(boxesIntersect(plan.serviceVolumes[0].box, plan.serviceVolumes[1].box)).toBe(false);
  });
});
