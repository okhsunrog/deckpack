import { describe, expect, it } from "vite-plus/test";
import { componentsLibrary, getCell } from "../data/library";
import { defaultConfig } from "../store/planner-store";
import type { ComponentPlacement } from "./types";
import {
  boxFromCenterSize,
  boxesIntersect,
  evaluateWorkspace,
  largestEmptyAxisAlignedBox,
} from "./geometry";
import { enumeratePackPlans } from "./packing";

describe("box geometry", () => {
  it("treats touching faces as non-overlapping", () => {
    const left = boxFromCenterSize([-5, 0, 0], [10, 10, 10]);
    const right = boxFromCenterSize([5, 0, 0], [10, 10, 10]);
    expect(boxesIntersect(left, right)).toBe(false);
  });

  it("finds a useful empty region around obstacles", () => {
    const container = boxFromCenterSize([0, 0, 0], [100, 40, 20]);
    const obstacle = boxFromCenterSize([-25, 0, 0], [50, 40, 20]);
    const free = largestEmptyAxisAlignedBox(container, [obstacle]);
    expect(free.volumeMm3).toBe(50 * 40 * 20);
  });
});

describe("workspace evaluation", () => {
  const config = structuredClone(defaultConfig);
  const plans = enumeratePackPlans({ config, cell: getCell(config.pack.cellId) }).plans;
  const plan = plans.find((candidate) => candidate.anchor === "nose") ?? plans[0];
  const esc = componentsLibrary.find((component) => component.id === "makerx-dv6s")!;

  function placement(x: number): ComponentPlacement {
    return {
      id: "esc-1",
      componentId: esc.id,
      position: [x, 0],
      rotationQuarterTurns: 0,
      dimensionsMm: { ...esc.dimensionsMm },
    };
  }

  it("detects a component dropped onto the battery", () => {
    const evaluation = evaluateWorkspace(config.enclosure, plan, [placement(0)]);
    expect(evaluation.hasCollision).toBe(true);
    expect(evaluation.components[0].collides).toBe(true);
  });

  it("accepts a component in the reserved tail space", () => {
    const tailX = -config.enclosure.dimensionsMm.length / 2 + esc.dimensionsMm.length / 2 + 5;
    const evaluation = evaluateWorkspace(config.enclosure, plan, [placement(tailX)]);
    expect(evaluation.hasCollision).toBe(false);
    expect(evaluation.freePercent).toBeGreaterThan(0);
    expect(evaluation.largestFreeBox.volumeMm3).toBeGreaterThan(0);
  });
});
