import { describe, expect, it } from "vite-plus/test";
import { getCell } from "../data/library";
import { defaultConfig } from "../store/planner-store";
import {
  boxCenter,
  boxContainmentKernel,
  boxesIntersect,
  boxSize,
  cylinderFitsProfile,
} from "./geometry";
import { enumeratePackPlans, factorTriples } from "./packing";
import { setWiringExitMode } from "./service-reservations";
import type { MeshHeightMapEnclosureSpec, PackPlan } from "./types";

function boxConfig(heightMm = 34) {
  const config = structuredClone(defaultConfig);
  config.enclosure = {
    kind: "box" as const,
    dimensionsMm: { length: 800, width: 210, height: heightMm },
  };
  config.pack.parallelCount = 4;
  config.pack.serviceReservations.forEach((reservation) => {
    reservation.enabled = reservation.kind === "wiring-exit";
  });
  return config;
}

// eve-50pl cylinder as the profile kernel sees it: sleeved cell plus
// fishpaper/nickel tolerances plus the outer wrap from the default stack.
const PROFILE_RADIUS_MM = (21.25 + 0.4) / 2 + 1;
const PROFILE_HALF_LENGTH_MM = (70.3 + 0.4) / 2 + 1;

function minCellZ(plan: PackPlan): number {
  return Math.min(...plan.cells.map((cell) => cell.position[2]));
}

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
  const config = boxConfig();
  const response = enumeratePackPlans({ config, cell: getCell(config.pack.cellId) });

  it("finds feasible brick layouts", () => {
    expect(response.exploredCount).toBeGreaterThan(0);
    expect(response.plans.length).toBeGreaterThan(0);
    expect(response.plans.some((plan) => plan.packingMode === "brick")).toBe(true);
  });

  it("drops staggered lattices that degenerate into the brick grid", () => {
    // A 34 mm box fits a single layer only, so every staggered variant would
    // be geometrically identical to brick and must be skipped.
    expect(response.plans.some((plan) => plan.packingMode === "staggered")).toBe(false);
  });

  it("keeps genuinely nested staggered layouts when the height allows them", () => {
    const tallConfig = boxConfig(60);
    const tall = enumeratePackPlans({ config: tallConfig, cell: getCell(tallConfig.pack.cellId) });
    const staggered = tall.plans.filter((plan) => plan.packingMode === "staggered");
    expect(staggered.length).toBeGreaterThan(0);
    expect(staggered.some((plan) => plan.metrics.layerCount === 2)).toBe(true);
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

  it("keeps a service volume attached to its pack face and only slides it along the edge", () => {
    const offsetConfig = boxConfig();
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
    expect(center[1] - block.max[1] - size[1] / 2).toBeCloseTo(0);
    expect(center[2] - blockCenter[2]).toBeCloseTo(0);
  });

  it("clamps service volume travel to the length of the selected edge", () => {
    const offsetConfig = boxConfig();
    const wiringExit = offsetConfig.pack.serviceReservations.find(
      (reservation) => reservation.kind === "wiring-exit",
    )!;
    wiringExit.face = "negative-x";
    wiringExit.offsetMm = [50, 10_000, -40];
    const plan = enumeratePackPlans({
      config: offsetConfig,
      cell: getCell(offsetConfig.pack.cellId),
    }).plans[0];
    const volume = plan.serviceVolumes.find((item) => item.id === wiringExit.id)!;
    const block = plan.blocks[0].envelope;
    const center = boxCenter(volume.box);
    const blockCenter = boxCenter(block);
    const size = boxSize(volume.box);

    expect(center[0] - block.min[0] + size[0] / 2).toBeCloseTo(0);
    expect(volume.box.max[1]).toBeCloseTo(block.max[1]);
    expect(center[2] - blockCenter[2]).toBeCloseTo(0);
  });

  it("starts advanced separate exits beside each other instead of overlapping", () => {
    const separateConfig = boxConfig();
    separateConfig.pack = setWiringExitMode(separateConfig.pack, "separate");
    const plan = enumeratePackPlans({
      config: separateConfig,
      cell: getCell(separateConfig.pack.cellId),
    }).plans[0];

    expect(plan.serviceVolumes).toHaveLength(2);
    expect(boxesIntersect(plan.serviceVolumes[0].box, plan.serviceVolumes[1].box)).toBe(false);
  });
});

describe("Spark case enumeration", () => {
  const spec = defaultConfig.enclosure as MeshHeightMapEnclosureSpec;
  const cell = getCell(defaultConfig.pack.cellId);
  const response = enumeratePackPlans({ config: defaultConfig, cell });

  it("fits the owned 12S3P of EVE 50PL cells as a two-layer staggered pack", () => {
    expect(defaultConfig.pack.seriesCount).toBe(12);
    expect(defaultConfig.pack.parallelCount).toBe(3);
    expect(cell.id).toBe("eve-50pl");
    expect(response.plans.length).toBeGreaterThan(0);
    expect(
      response.plans.some(
        (plan) => plan.packingMode === "staggered" && plan.metrics.layerCount === 2,
      ),
    ).toBe(true);
  });

  it("passes the exact cylinder check for every cell of every plan", () => {
    for (const plan of response.plans) {
      for (const placed of plan.cells) {
        expect(
          cylinderFitsProfile(
            spec,
            {
              centerXmm: placed.position[0],
              centerYmm: placed.position[1],
              axis: plan.orientation,
              radiusMm: PROFILE_RADIUS_MM,
              halfLengthMm: PROFILE_HALF_LENGTH_MM,
            },
            placed.position[2],
          ),
        ).toBe(true);
      }
    }
  });

  it("never lets two cells physically intersect", () => {
    for (const plan of response.plans) {
      const axial = { x: 0, y: 1, z: 2 }[plan.orientation];
      const cells = plan.cells.map((placed) => placed.position);
      for (let i = 0; i < cells.length; i += 1) {
        for (let j = i + 1; j < cells.length; j += 1) {
          const axialGap = Math.abs(cells[i][axial] - cells[j][axial]);
          if (axialGap >= cell.sleevedHeightMm) continue;
          let radialSq = 0;
          for (let axis = 0; axis < 3; axis += 1) {
            if (axis === axial) continue;
            radialSq += (cells[i][axis] - cells[j][axis]) ** 2;
          }
          expect(Math.sqrt(radialSq)).toBeGreaterThanOrEqual(cell.sleevedDiameterMm - 1e-6);
        }
      }
    }
  });

  it("rests the main bottom layer on the 48 mm deep floor when the pack fits it", () => {
    const config = structuredClone(defaultConfig);
    config.pack.parallelCount = 2;
    const plans = enumeratePackPlans({ config, cell }).plans;
    const deepRestZ = spec.dimensionsMm.height / 2 - 48 + PROFILE_RADIUS_MM;
    const resting = plans.filter((plan) => Math.abs(minCellZ(plan) - deepRestZ) < 0.01);
    expect(resting.length).toBeGreaterThan(0);
    expect(resting.some((plan) => plan.metrics.layerCount === 2)).toBe(true);
  });

  it("respects maxLayers while still exploring two-layer variants", () => {
    for (const plan of response.plans) {
      expect(plan.metrics.layerCount).toBeLessThanOrEqual(defaultConfig.pack.maxLayers);
    }
    expect(response.plans.some((plan) => plan.metrics.layerCount === 2)).toBe(true);
  });
});
