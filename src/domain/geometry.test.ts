import { describe, expect, it } from "vite-plus/test";
import { registerEnclosureAsset, type HeightMapAsset } from "../data/enclosures";
import { componentsLibrary, getCell } from "../data/library";
import { defaultConfig } from "../store/planner-store";
import type { ComponentPlacement, MeshHeightMapEnclosureSpec } from "./types";
import {
  availableDepthForBox,
  availableDepthForFootprint,
  boxFromCenterSize,
  boxesIntersect,
  cylinderFitsProfile,
  evaluateWorkspace,
  footprintsIntersect,
  largestEmptyAxisAlignedBox,
  minCylinderCenterZ,
  settleComponentCenterZ,
  unionVolumeMm3,
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

describe("Spark case geometry", () => {
  it("uses the inner STL surface instead of the outer shell", () => {
    const shallowProbe = boxFromCenterSize([-95, 0, 0], [2, 2, 0]);
    const deepProbe = boxFromCenterSize([50, 0, 0], [2, 2, 0]);

    expect(availableDepthForBox(defaultConfig.enclosure, shallowProbe)).toBe(34);
    expect(availableDepthForBox(defaultConfig.enclosure, deepProbe)).toBe(46);
  });

  it("has no vertical obstacle at the two-part joint", () => {
    // The printable halves overlap by 5 mm around x ≈ 0; a butt joint used to
    // leave a shallow stripe in the depth map.
    for (let x = -20; x <= 20; x += 2) {
      const probe = boxFromCenterSize([x, 0, 0], [2, 60, 0]);
      expect(availableDepthForBox(defaultConfig.enclosure, probe)).toBe(46);
    }
  });
});

function buildRampAsset(): HeightMapAsset {
  // Deep 46 mm floor for x < 0, a linear ramp rising 1.2 mm per mm over
  // 0..10, then a 34 mm shelf: the shape that forces the AABB-vs-cylinder
  // distinction near the Spark case ramp.
  const stepMm = 0.5;
  const columns = 121;
  const rows = 81;
  const origin: [number, number] = [-30, -20];
  const data = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = origin[0] + column * stepMm;
      const depth = x < 0 ? 46 : x < 10 ? 46 - 1.2 * x : 34;
      data[row * columns + column] = Math.round(depth / 0.25);
    }
  }
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return {
    id: "test-ramp",
    label: "Test ramp",
    kind: "mesh-heightmap",
    dimensionsMm: { length: 60, width: 40, height: 50 },
    modelUrl: "",
    meshTriangles: 0,
    depthMap: {
      originMm: origin,
      stepMm,
      columns,
      rows,
      depthQuantizationMm: 0.25,
      safetyMarginMm: 0.5,
      minDepthMm: 34,
      maxDepthMm: 46,
      usableVolumeMm3: 1,
      dataBase64: btoa(binary),
    },
  };
}

describe("cylinder vs height field", () => {
  registerEnclosureAsset(buildRampAsset());
  const spec: MeshHeightMapEnclosureSpec = {
    kind: "mesh-heightmap",
    assetId: "test-ramp",
    dimensionsMm: { length: 60, width: 40, height: 50 },
  };
  const radiusMm = 11;
  const halfLengthMm = 15;
  const deepRestZ = 50 / 2 - 46 + radiusMm; // resting on the deep floor

  it("lets a horizontal cell overhang the ramp when the curved side clears it", () => {
    const cylinder = {
      centerXmm: -8,
      centerYmm: 0,
      axis: "y" as const,
      radiusMm,
      halfLengthMm,
    };
    // The bounding box hangs over the ramp, so the box test would demand more
    // depth than exists there...
    const footprint = boxFromCenterSize([-8, 0, 0], [radiusMm * 2, halfLengthMm * 2, 0]);
    expect(availableDepthForBox(spec, footprint)).toBeLessThan(46);
    // ...but the real cylinder still settles onto the deep floor.
    expect(minCylinderCenterZ(spec, cylinder)).toBeCloseTo(deepRestZ, 6);
    expect(cylinderFitsProfile(spec, cylinder, deepRestZ)).toBe(true);
  });

  it("rejects a real intersection between the cylinder and the ramp", () => {
    const cylinder = {
      centerXmm: 2,
      centerYmm: 0,
      axis: "y" as const,
      radiusMm,
      halfLengthMm,
    };
    expect(minCylinderCenterZ(spec, cylinder)).toBeGreaterThan(deepRestZ + 1);
    expect(cylinderFitsProfile(spec, cylinder, deepRestZ)).toBe(false);
  });

  it("treats leaving the sampled grid as a wall", () => {
    const cylinder = {
      centerXmm: -25,
      centerYmm: 0,
      axis: "y" as const,
      radiusMm,
      halfLengthMm,
    };
    expect(minCylinderCenterZ(spec, cylinder)).toBe(Infinity);
  });
});

describe("rotated footprints", () => {
  it("lets a diagonal component pass where its bounding box would collide", () => {
    // A 60×20 plate rotated 45° sits diagonally next to an axis-aligned block.
    const diagonal = {
      centerXmm: 30,
      centerYmm: 30,
      halfLengthMm: 30,
      halfWidthMm: 10,
      angleRad: Math.PI / 4,
    };
    const block = {
      centerXmm: 45,
      centerYmm: 5,
      halfLengthMm: 10,
      halfWidthMm: 10,
      angleRad: 0,
    };
    // Bounding boxes overlap (diagonal AABB spans ~2..58 in both axes)...
    expect(
      boxesIntersect(
        boxFromCenterSize([30, 30, 0], [57, 57, 10]),
        boxFromCenterSize([45, 5, 0], [20, 20, 10]),
      ),
    ).toBe(true);
    // ...but the actual rectangles are separated, and a truly crossing block is not.
    expect(footprintsIntersect(diagonal, block)).toBe(false);
    expect(footprintsIntersect(diagonal, { ...block, centerXmm: 30, centerYmm: 25 })).toBe(true);
  });

  it("settles a pitched component onto a ramp instead of perching it flat", () => {
    const spec: MeshHeightMapEnclosureSpec = {
      kind: "mesh-heightmap",
      assetId: "test-ramp",
      dimensionsMm: { length: 60, width: 40, height: 50 },
    };
    // 20 mm plate straddling the ramp edge at x = 0 (deep floor left, ramp right).
    const place = (tiltDeg: number): ComponentPlacement => ({
      id: "plate",
      componentId: "custom",
      position: [2, 0],
      rotationDeg: 0,
      tiltDeg,
      dimensionsMm: { length: 20, width: 10, height: 4 },
    });
    const flat = settleComponentCenterZ(spec, place(0));
    // The test ramp rises toward +x, so the plate lies along it nose-up.
    const pitched = settleComponentCenterZ(spec, place(-50));
    // Flat it must sit on the highest floor point under it; pitched along the
    // ramp its trailing edge reaches down toward the deep floor.
    expect(Number.isFinite(flat)).toBe(true);
    expect(Number.isFinite(pitched)).toBe(true);
    expect(pitched).toBeLessThan(flat);
    // Box-enclosure formula: flat = floor + h/2, vertical = floor + L/2.
    const boxSpec = { kind: "box" as const, dimensionsMm: { length: 100, width: 50, height: 30 } };
    expect(settleComponentCenterZ(boxSpec, place(0))).toBeCloseTo(-15 + 2);
    expect(settleComponentCenterZ(boxSpec, place(90))).toBeCloseTo(-15 + 10);
  });

  it("rests a rotated component on the depth of its true footprint", () => {
    // Diagonal plate near the test ramp: its AABB reaches over the ramp but the
    // rectangle itself stays on the deep floor.
    const spec: MeshHeightMapEnclosureSpec = {
      kind: "mesh-heightmap",
      assetId: "test-ramp",
      dimensionsMm: { length: 60, width: 40, height: 50 },
    };
    const footprint = {
      centerXmm: -14,
      centerYmm: 0,
      halfLengthMm: 14,
      halfWidthMm: 5,
      angleRad: Math.PI / 4,
    };
    // AABB reaches x ≈ -0.5..+? → over the ramp; the rotated rect ends left of 0...
    expect(availableDepthForFootprint(spec, footprint)).toBe(46);
    expect(availableDepthForFootprint(spec, { ...footprint, centerXmm: 2 })).toBeLessThan(46);
  });
});

describe("union volume", () => {
  const container = boxFromCenterSize([0, 0, 0], [100, 100, 100]);

  it("does not double count overlapping boxes", () => {
    const box = boxFromCenterSize([0, 0, 0], [10, 10, 10]);
    expect(unionVolumeMm3(container, [box, box])).toBeCloseTo(1000);
  });

  it("clips boxes to the container", () => {
    const outside = boxFromCenterSize([1000, 0, 0], [10, 10, 10]);
    const straddling = boxFromCenterSize([50, 0, 0], [10, 10, 10]);
    expect(unionVolumeMm3(container, [outside])).toBe(0);
    expect(unionVolumeMm3(container, [straddling])).toBeCloseTo(500);
  });
});

describe("workspace evaluation", () => {
  const config = structuredClone(defaultConfig);
  config.enclosure = {
    kind: "box",
    dimensionsMm: { length: 800, width: 210, height: 34 },
  };
  config.pack.parallelCount = 4;
  config.pack.serviceReservations.forEach((reservation) => {
    reservation.enabled = reservation.kind === "wiring-exit";
  });
  const plans = enumeratePackPlans({ config, cell: getCell(config.pack.cellId) }).plans;
  const plan = plans.find((candidate) => candidate.anchor === "nose") ?? plans[0];
  const esc = componentsLibrary.find((component) => component.id === "makerx-dv6s")!;

  function placement(x: number): ComponentPlacement {
    return {
      id: "esc-1",
      componentId: esc.id,
      position: [x, 0],
      rotationDeg: 0,
      tiltDeg: 0,
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
