import type {
  Axis,
  Box3D,
  ComponentPlacement,
  Dimensions3D,
  EnclosureSpec,
  LargestFreeBox,
  MeshHeightMapEnclosureSpec,
  PackPlan,
  Vec3,
  WorkspaceEvaluation,
} from "./types";
import { getHeightMapAsset } from "../data/enclosures";

const EPSILON = 1e-6;

export interface ContainmentKernel<TSpec> {
  bounds(spec: TSpec): Box3D;
  contains(spec: TSpec, object: Box3D): boolean;
  clearance(spec: TSpec, object: Box3D): number;
  volume(spec: TSpec): number;
}

export const boxContainmentKernel: ContainmentKernel<EnclosureSpec> = {
  bounds: enclosureBounds,
  contains(spec, object) {
    return containsBox(enclosureBounds(spec), object);
  },
  clearance(spec, object) {
    const container = enclosureBounds(spec);
    return Math.min(
      object.min[0] - container.min[0],
      container.max[0] - object.max[0],
      object.min[1] - container.min[1],
      container.max[1] - object.max[1],
      object.min[2] - container.min[2],
      container.max[2] - object.max[2],
    );
  },
  volume(spec) {
    const { length, width, height } = spec.dimensionsMm;
    return length * width * height;
  },
};

interface CompiledHeightMap {
  columns: number;
  rows: number;
  origin: [number, number];
  stepMm: number;
  quantizationMm: number;
  safetyMarginMm: number;
  /** Sparse min-tables along columns: levels[k][row*columns+c] = min depth over c..c+2^k-1. */
  levels: Uint8Array[];
  /** Sparse min-tables along rows: rowLevels[k][r*columns+column] = min depth over r..r+2^k-1. */
  rowLevels: Uint8Array[];
}

const compiledHeightMaps = new Map<string, CompiledHeightMap>();

function decodeBase64Bytes(value: string): Uint8Array {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function compiledHeightMap(spec: EnclosureSpec): CompiledHeightMap {
  if (spec.kind !== "mesh-heightmap") throw new Error("Height map enclosure required");
  const cached = compiledHeightMaps.get(spec.assetId);
  if (cached) return cached;
  const asset = getHeightMapAsset(spec);
  const { columns, rows } = asset.depthMap;
  const base = decodeBase64Bytes(asset.depthMap.dataBase64);
  if (base.length !== columns * rows) throw new Error(`Invalid height map: ${spec.assetId}`);
  const levels = [base];
  for (let span = 1; span * 2 <= columns; span *= 2) {
    const previous = levels.at(-1)!;
    const next = new Uint8Array(previous.length);
    for (let row = 0; row < rows; row += 1) {
      const rowOffset = row * columns;
      for (let column = 0; column < columns; column += 1) {
        const right = Math.min(columns - 1, column + span);
        next[rowOffset + column] = Math.min(
          previous[rowOffset + column],
          previous[rowOffset + right],
        );
      }
    }
    levels.push(next);
  }
  const rowLevels = [base];
  for (let span = 1; span * 2 <= rows; span *= 2) {
    const previous = rowLevels.at(-1)!;
    const next = new Uint8Array(previous.length);
    for (let row = 0; row < rows; row += 1) {
      const below = Math.min(rows - 1, row + span);
      for (let column = 0; column < columns; column += 1) {
        next[row * columns + column] = Math.min(
          previous[row * columns + column],
          previous[below * columns + column],
        );
      }
    }
    rowLevels.push(next);
  }
  const compiled: CompiledHeightMap = {
    columns,
    rows,
    origin: asset.depthMap.originMm,
    stepMm: asset.depthMap.stepMm,
    quantizationMm: asset.depthMap.depthQuantizationMm,
    safetyMarginMm: asset.depthMap.safetyMarginMm,
    levels,
    rowLevels,
  };
  compiledHeightMaps.set(spec.assetId, compiled);
  return compiled;
}

function rowRangeMinimum(
  map: CompiledHeightMap,
  row: number,
  firstColumn: number,
  lastColumn: number,
): number {
  const length = lastColumn - firstColumn + 1;
  const level = Math.floor(Math.log2(length));
  const span = 2 ** level;
  const values = map.levels[level];
  const rowOffset = row * map.columns;
  return Math.min(values[rowOffset + firstColumn], values[rowOffset + lastColumn - span + 1]);
}

function columnRangeMinimum(
  map: CompiledHeightMap,
  column: number,
  firstRow: number,
  lastRow: number,
): number {
  const length = lastRow - firstRow + 1;
  const level = Math.floor(Math.log2(length));
  const span = 2 ** level;
  const values = map.rowLevels[level];
  return Math.min(
    values[firstRow * map.columns + column],
    values[(lastRow - span + 1) * map.columns + column],
  );
}

export function availableDepthForBox(spec: EnclosureSpec, object: Box3D): number {
  if (spec.kind === "box") return spec.dimensionsMm.height;
  const map = compiledHeightMap(spec);
  const margin = map.safetyMarginMm;
  const firstColumn = Math.floor((object.min[0] - margin - map.origin[0]) / map.stepMm);
  const lastColumn = Math.ceil((object.max[0] + margin - map.origin[0]) / map.stepMm);
  const firstRow = Math.floor((object.min[1] - margin - map.origin[1]) / map.stepMm);
  const lastRow = Math.ceil((object.max[1] + margin - map.origin[1]) / map.stepMm);
  if (firstColumn < 0 || lastColumn >= map.columns || firstRow < 0 || lastRow >= map.rows) {
    return 0;
  }
  let minimum = 255;
  for (let row = firstRow; row <= lastRow; row += 1) {
    minimum = Math.min(minimum, rowRangeMinimum(map, row, firstColumn, lastColumn));
    if (minimum === 0) return 0;
  }
  return minimum * map.quantizationMm;
}

/**
 * A finished cell as the profile kernel sees it: the axis-aligned cylinder that
 * must clear the enclosure's inner surface. Radius and half-length include the
 * per-cell tolerance layers plus the outer wrap.
 */
export interface ProfileCylinder {
  centerXmm: number;
  centerYmm: number;
  axis: Axis;
  radiusMm: number;
  halfLengthMm: number;
}

/** Highest allowed cylinder-center z before the cell pokes through the lid plane. */
export function cylinderTopLimitZ(
  spec: MeshHeightMapEnclosureSpec,
  cylinder: ProfileCylinder,
): number {
  const topZ = spec.dimensionsMm.height / 2;
  return topZ - (cylinder.axis === "z" ? cylinder.halfLengthMm : cylinder.radiusMm);
}

/**
 * Lowest cylinder-center z at which the cell does not penetrate the inner
 * surface of the enclosure. For a horizontal cylinder the lower surface rises
 * toward the sides by sqrt(r² − d²), so a cell may legitimately overhang a ramp
 * that its bounding box would collide with. Returns Infinity when the footprint
 * leaves the sampled grid (treated as a wall).
 */
export function minCylinderCenterZ(
  spec: MeshHeightMapEnclosureSpec,
  cylinder: ProfileCylinder,
): number {
  const map = compiledHeightMap(spec);
  const { stepMm, quantizationMm } = map;
  const margin = map.safetyMarginMm;
  const halfStep = stepMm / 2;
  const topZ = spec.dimensionsMm.height / 2;
  const { centerXmm, centerYmm, radiusMm, halfLengthMm } = cylinder;
  const columnAt = (x: number) => (x - map.origin[0]) / stepMm;
  const rowAt = (y: number) => (y - map.origin[1]) / stepMm;

  if (cylinder.axis === "x" || cylinder.axis === "y") {
    const axialAlongX = cylinder.axis === "x";
    const axial = axialAlongX ? centerXmm : centerYmm;
    const lateral = axialAlongX ? centerYmm : centerXmm;
    const toAxial = axialAlongX ? columnAt : rowAt;
    const toLateral = axialAlongX ? rowAt : columnAt;
    const axialLimit = axialAlongX ? map.columns : map.rows;
    const lateralLimit = axialAlongX ? map.rows : map.columns;
    const a0 = Math.floor(toAxial(axial - halfLengthMm - margin));
    const a1 = Math.ceil(toAxial(axial + halfLengthMm + margin));
    const l0 = Math.floor(toLateral(lateral - radiusMm - margin));
    const l1 = Math.ceil(toLateral(lateral + radiusMm + margin));
    if (a0 < 0 || a1 >= axialLimit || l0 < 0 || l1 >= lateralLimit) return Infinity;
    let minCenter = -Infinity;
    for (let line = l0; line <= l1; line += 1) {
      const lineCoordinate = (axialAlongX ? map.origin[1] : map.origin[0]) + line * stepMm;
      const offset = Math.max(0, Math.abs(lineCoordinate - lateral) - halfStep - margin);
      if (offset >= radiusMm) continue;
      const depth =
        (axialAlongX ? rowRangeMinimum(map, line, a0, a1) : columnRangeMinimum(map, line, a0, a1)) *
        quantizationMm;
      const surfaceDrop = Math.sqrt(radiusMm * radiusMm - offset * offset);
      minCenter = Math.max(minCenter, topZ - depth + surfaceDrop);
    }
    return minCenter;
  }

  const r0 = Math.floor(rowAt(centerYmm - radiusMm - margin));
  const r1 = Math.ceil(rowAt(centerYmm + radiusMm + margin));
  if (r0 < 0 || r1 >= map.rows) return Infinity;
  let minCenter = -Infinity;
  for (let row = r0; row <= r1; row += 1) {
    const y = map.origin[1] + row * stepMm;
    const offset = Math.max(0, Math.abs(y - centerYmm) - halfStep - margin);
    if (offset >= radiusMm) continue;
    const halfWidth = Math.sqrt(radiusMm * radiusMm - offset * offset);
    const c0 = Math.floor(columnAt(centerXmm - halfWidth - margin));
    const c1 = Math.ceil(columnAt(centerXmm + halfWidth + margin));
    if (c0 < 0 || c1 >= map.columns) return Infinity;
    const depth = rowRangeMinimum(map, row, c0, c1) * quantizationMm;
    minCenter = Math.max(minCenter, topZ - depth + halfLengthMm);
  }
  return minCenter;
}

/** True when the cylinder at its given center z fits the profile and the lid. */
export function cylinderFitsProfile(
  spec: MeshHeightMapEnclosureSpec,
  cylinder: ProfileCylinder,
  centerZmm: number,
): boolean {
  return (
    centerZmm + EPSILON >= minCylinderCenterZ(spec, cylinder) &&
    centerZmm <= cylinderTopLimitZ(spec, cylinder) + EPSILON
  );
}

export const enclosureContainmentKernel: ContainmentKernel<EnclosureSpec> = {
  bounds: enclosureBounds,
  contains(spec, object) {
    if (spec.kind === "box") return boxContainmentKernel.contains(spec, object);
    const container = enclosureBounds(spec);
    const topZ = container.max[2];
    const requiredDepth = topZ - object.min[2];
    return (
      object.max[2] <= topZ + EPSILON &&
      object.min[2] >= container.min[2] - EPSILON &&
      availableDepthForBox(spec, object) + EPSILON >= requiredDepth
    );
  },
  clearance(spec, object) {
    if (spec.kind === "box") return boxContainmentKernel.clearance(spec, object);
    const container = enclosureBounds(spec);
    const floorZ = container.max[2] - availableDepthForBox(spec, object);
    return Math.min(
      object.min[0] - container.min[0],
      container.max[0] - object.max[0],
      object.min[1] - container.min[1],
      container.max[1] - object.max[1],
      object.min[2] - floorZ,
      container.max[2] - object.max[2],
    );
  },
  volume(spec) {
    if (spec.kind === "box") return boxContainmentKernel.volume(spec);
    return getHeightMapAsset(spec).depthMap.usableVolumeMm3;
  },
};

export function enclosureBounds(spec: EnclosureSpec): Box3D {
  const { length, width, height } = spec.dimensionsMm;
  return {
    min: [-length / 2, -width / 2, -height / 2],
    max: [length / 2, width / 2, height / 2],
  };
}

export function boxFromCenterSize(center: Vec3, size: Vec3): Box3D {
  return {
    min: [center[0] - size[0] / 2, center[1] - size[1] / 2, center[2] - size[2] / 2],
    max: [center[0] + size[0] / 2, center[1] + size[1] / 2, center[2] + size[2] / 2],
  };
}

export function boxSize(box: Box3D): Vec3 {
  return [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
}

export function boxCenter(box: Box3D): Vec3 {
  return [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];
}

export function boxVolume(box: Box3D): number {
  const size = boxSize(box);
  return Math.max(0, size[0]) * Math.max(0, size[1]) * Math.max(0, size[2]);
}

export function translateBox(box: Box3D, offset: Vec3): Box3D {
  return {
    min: [box.min[0] + offset[0], box.min[1] + offset[1], box.min[2] + offset[2]],
    max: [box.max[0] + offset[0], box.max[1] + offset[1], box.max[2] + offset[2]],
  };
}

export function expandBox(box: Box3D, amount: Vec3): Box3D {
  return {
    min: [box.min[0] - amount[0], box.min[1] - amount[1], box.min[2] - amount[2]],
    max: [box.max[0] + amount[0], box.max[1] + amount[1], box.max[2] + amount[2]],
  };
}

export function unionBoxes(boxes: Box3D[]): Box3D {
  if (boxes.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  const result: Box3D = { min: [...boxes[0].min], max: [...boxes[0].max] };
  for (const box of boxes.slice(1)) {
    for (let axis = 0; axis < 3; axis += 1) {
      result.min[axis] = Math.min(result.min[axis], box.min[axis]);
      result.max[axis] = Math.max(result.max[axis], box.max[axis]);
    }
  }
  return result;
}

export function containsBox(container: Box3D, object: Box3D): boolean {
  return (
    object.min.every((value, axis) => value >= container.min[axis] - EPSILON) &&
    object.max.every((value, axis) => value <= container.max[axis] + EPSILON)
  );
}

export function boxesIntersect(a: Box3D, b: Box3D, clearance = 0): boolean {
  return [0, 1, 2].every(
    (axis) => a.min[axis] < b.max[axis] + clearance && a.max[axis] > b.min[axis] - clearance,
  );
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function largestEmptyAxisAlignedBox(container: Box3D, obstacles: Box3D[]): LargestFreeBox {
  const clipped = obstacles.filter((obstacle) => boxesIntersect(container, obstacle));
  const coordinates = ([0, 1, 2] as const).map((axis) => {
    const values = new Set<number>([container.min[axis], container.max[axis]]);
    for (const obstacle of clipped) {
      values.add(Math.max(container.min[axis], Math.min(container.max[axis], obstacle.min[axis])));
      values.add(Math.max(container.min[axis], Math.min(container.max[axis], obstacle.max[axis])));
    }
    return [...values].sort((a, b) => a - b);
  });

  let best: LargestFreeBox = {
    box: { min: [...container.min], max: [...container.min] },
    volumeMm3: 0,
  };
  for (let x0 = 0; x0 < coordinates[0].length - 1; x0 += 1) {
    for (let x1 = x0 + 1; x1 < coordinates[0].length; x1 += 1) {
      for (let y0 = 0; y0 < coordinates[1].length - 1; y0 += 1) {
        for (let y1 = y0 + 1; y1 < coordinates[1].length; y1 += 1) {
          for (let z0 = 0; z0 < coordinates[2].length - 1; z0 += 1) {
            for (let z1 = z0 + 1; z1 < coordinates[2].length; z1 += 1) {
              const candidate: Box3D = {
                min: [coordinates[0][x0], coordinates[1][y0], coordinates[2][z0]],
                max: [coordinates[0][x1], coordinates[1][y1], coordinates[2][z1]],
              };
              const volume = boxVolume(candidate);
              if (volume <= best.volumeMm3) continue;
              if (clipped.some((obstacle) => boxesIntersect(candidate, obstacle))) continue;
              best = { box: candidate, volumeMm3: volume };
            }
          }
        }
      }
    }
  }
  return best;
}

export function clipBoxToContainer(container: Box3D, box: Box3D): Box3D | undefined {
  const min: Vec3 = [0, 0, 0];
  const max: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    min[axis] = Math.max(container.min[axis], box.min[axis]);
    max[axis] = Math.min(container.max[axis], box.max[axis]);
    if (max[axis] - min[axis] <= 0) return undefined;
  }
  return { min, max };
}

/** Exact volume of the union of boxes clipped to the container (no double counting). */
export function unionVolumeMm3(container: Box3D, boxes: Box3D[]): number {
  const clipped = boxes
    .map((box) => clipBoxToContainer(container, box))
    .filter((box): box is Box3D => box !== undefined);
  if (clipped.length === 0) return 0;
  const coordinates = ([0, 1, 2] as const).map((axis) => {
    const values = new Set<number>();
    for (const box of clipped) {
      values.add(box.min[axis]);
      values.add(box.max[axis]);
    }
    return [...values].sort((a, b) => a - b);
  });
  const [xs, ys, zs] = coordinates;
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const nz = zs.length - 1;
  const occupied = new Uint8Array(nx * ny * nz);
  const indexOf = (values: number[], value: number) => {
    let low = 0;
    let high = values.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (values[mid] < value) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  for (const box of clipped) {
    const x0 = indexOf(xs, box.min[0]);
    const x1 = indexOf(xs, box.max[0]);
    const y0 = indexOf(ys, box.min[1]);
    const y1 = indexOf(ys, box.max[1]);
    const z0 = indexOf(zs, box.min[2]);
    const z1 = indexOf(zs, box.max[2]);
    for (let x = x0; x < x1; x += 1) {
      for (let y = y0; y < y1; y += 1) {
        for (let z = z0; z < z1; z += 1) {
          occupied[(x * ny + y) * nz + z] = 1;
        }
      }
    }
  }
  let volume = 0;
  for (let x = 0; x < nx; x += 1) {
    const dx = xs[x + 1] - xs[x];
    for (let y = 0; y < ny; y += 1) {
      const area = dx * (ys[y + 1] - ys[y]);
      for (let z = 0; z < nz; z += 1) {
        if (occupied[(x * ny + y) * nz + z]) volume += area * (zs[z + 1] - zs[z]);
      }
    }
  }
  return volume;
}

export function dimensionsToVec3(dimensions: Dimensions3D): Vec3 {
  return [dimensions.length, dimensions.width, dimensions.height];
}

/** A component's rotated rectangular footprint in the deck plane. */
export interface Footprint2D {
  centerXmm: number;
  centerYmm: number;
  halfLengthMm: number;
  halfWidthMm: number;
  angleRad: number;
}

export function componentFootprint(placement: ComponentPlacement): Footprint2D {
  const tilt = (placement.tiltDeg * Math.PI) / 180;
  // The plan projection of a pitched box is still a rectangle: the length
  // shortens by cos(tilt) while the box height leans into the plan by sin.
  const halfLengthMm =
    (placement.dimensionsMm.length / 2) * Math.abs(Math.cos(tilt)) +
    (placement.dimensionsMm.height / 2) * Math.abs(Math.sin(tilt));
  return {
    centerXmm: placement.position[0],
    centerYmm: placement.position[1],
    halfLengthMm,
    halfWidthMm: placement.dimensionsMm.width / 2,
    angleRad: (placement.rotationDeg * Math.PI) / 180,
  };
}

/**
 * Lowest possible center z of a (possibly pitched) component resting on the
 * enclosure floor: the inclined bottom face settles onto the height map like a
 * rigid plate. Returns Infinity when the face leaves the sampled grid or sits
 * over a wall.
 */
export function settleComponentCenterZ(spec: EnclosureSpec, placement: ComponentPlacement): number {
  const { length, height } = placement.dimensionsMm;
  const tilt = (placement.tiltDeg * Math.PI) / 180;
  const sinT = Math.sin(tilt);
  const cosT = Math.cos(tilt);
  if (spec.kind === "box") {
    return (
      -spec.dimensionsMm.height / 2 + (length / 2) * Math.abs(sinT) + (height / 2) * Math.abs(cosT)
    );
  }
  const map = compiledHeightMap(spec);
  const margin = map.safetyMarginMm;
  const topZ = spec.dimensionsMm.height / 2;
  const yaw = (placement.rotationDeg * Math.PI) / 180;
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  // Plan center of the bottom face: shifted opposite to the lean direction.
  const faceCenterX = placement.position[0] - (height / 2) * sinT * cosY;
  const faceCenterY = placement.position[1] - (height / 2) * sinT * sinY;
  const halfU = (length / 2) * Math.abs(cosT);
  const halfV = placement.dimensionsMm.width / 2;
  const reachX = Math.abs(cosY) * halfU + Math.abs(sinY) * halfV + margin;
  const reachY = Math.abs(sinY) * halfU + Math.abs(cosY) * halfV + margin;
  const c0 = Math.floor((faceCenterX - reachX - map.origin[0]) / map.stepMm);
  const c1 = Math.ceil((faceCenterX + reachX - map.origin[0]) / map.stepMm);
  const r0 = Math.floor((faceCenterY - reachY - map.origin[1]) / map.stepMm);
  const r1 = Math.ceil((faceCenterY + reachY - map.origin[1]) / map.stepMm);
  if (c0 < 0 || c1 >= map.columns || r0 < 0 || r1 >= map.rows) return Infinity;
  const cosSafe = Math.max(Math.abs(cosT), 1e-6);
  const base = map.levels[0];
  let minCenterZ = -Infinity;
  for (let row = r0; row <= r1; row += 1) {
    const dy = map.origin[1] + row * map.stepMm - faceCenterY;
    for (let column = c0; column <= c1; column += 1) {
      const dx = map.origin[0] + column * map.stepMm - faceCenterX;
      const uPlan = dx * cosY + dy * sinY;
      if (Math.abs(uPlan) > halfU + margin) continue;
      const v = -dx * sinY + dy * cosY;
      if (Math.abs(v) > halfV + margin) continue;
      const depth = base[row * map.columns + column];
      if (depth === 0) return Infinity;
      const u = uPlan / cosSafe;
      const floorZ = topZ - depth * map.quantizationMm;
      minCenterZ = Math.max(minCenterZ, floorZ + u * sinT + (height / 2) * cosT);
    }
  }
  return Number.isFinite(minCenterZ) ? minCenterZ : Infinity;
}

/** Vertical half-extent of a pitched component's bounding box. */
export function componentHalfHeight(placement: ComponentPlacement): number {
  const tilt = (placement.tiltDeg * Math.PI) / 180;
  return (
    (placement.dimensionsMm.length / 2) * Math.abs(Math.sin(tilt)) +
    (placement.dimensionsMm.height / 2) * Math.abs(Math.cos(tilt))
  );
}

function boxFootprint(box: Box3D): Footprint2D {
  return {
    centerXmm: (box.min[0] + box.max[0]) / 2,
    centerYmm: (box.min[1] + box.max[1]) / 2,
    halfLengthMm: (box.max[0] - box.min[0]) / 2,
    halfWidthMm: (box.max[1] - box.min[1]) / 2,
    angleRad: 0,
  };
}

export function footprintCorners(footprint: Footprint2D): Array<[number, number]> {
  const cos = Math.cos(footprint.angleRad);
  const sin = Math.sin(footprint.angleRad);
  const corners: Array<[number, number]> = [];
  for (const su of [-1, 1]) {
    for (const sv of [-1, 1]) {
      const u = su * footprint.halfLengthMm;
      const v = sv * footprint.halfWidthMm;
      corners.push([
        footprint.centerXmm + u * cos - v * sin,
        footprint.centerYmm + u * sin + v * cos,
      ]);
    }
  }
  return corners;
}

/** Separating-axis test for two rotated rectangles in the deck plane. */
export function footprintsIntersect(a: Footprint2D, b: Footprint2D): boolean {
  const cornersA = footprintCorners(a);
  const cornersB = footprintCorners(b);
  for (const shape of [a, b]) {
    const axes: Array<[number, number]> = [
      [Math.cos(shape.angleRad), Math.sin(shape.angleRad)],
      [-Math.sin(shape.angleRad), Math.cos(shape.angleRad)],
    ];
    for (const [ax, ay] of axes) {
      let minA = Infinity;
      let maxA = -Infinity;
      for (const [x, y] of cornersA) {
        const dot = x * ax + y * ay;
        minA = Math.min(minA, dot);
        maxA = Math.max(maxA, dot);
      }
      let minB = Infinity;
      let maxB = -Infinity;
      for (const [x, y] of cornersB) {
        const dot = x * ax + y * ay;
        minB = Math.min(minB, dot);
        maxB = Math.max(maxB, dot);
      }
      if (maxA <= minB + EPSILON || maxB <= minA + EPSILON) return false;
    }
  }
  return true;
}

/**
 * Free depth under a rotated footprint: minimum over the height-map cells the
 * rectangle actually covers, so a diagonal component is not penalized for the
 * corners of its axis-aligned bounding box.
 */
export function availableDepthForFootprint(spec: EnclosureSpec, footprint: Footprint2D): number {
  if (spec.kind === "box") return spec.dimensionsMm.height;
  const map = compiledHeightMap(spec);
  const margin = map.safetyMarginMm;
  const cos = Math.cos(footprint.angleRad);
  const sin = Math.sin(footprint.angleRad);
  const reachX =
    Math.abs(cos) * footprint.halfLengthMm + Math.abs(sin) * footprint.halfWidthMm + margin;
  const reachY =
    Math.abs(sin) * footprint.halfLengthMm + Math.abs(cos) * footprint.halfWidthMm + margin;
  const c0 = Math.floor((footprint.centerXmm - reachX - map.origin[0]) / map.stepMm);
  const c1 = Math.ceil((footprint.centerXmm + reachX - map.origin[0]) / map.stepMm);
  const r0 = Math.floor((footprint.centerYmm - reachY - map.origin[1]) / map.stepMm);
  const r1 = Math.ceil((footprint.centerYmm + reachY - map.origin[1]) / map.stepMm);
  if (c0 < 0 || c1 >= map.columns || r0 < 0 || r1 >= map.rows) return 0;
  const uLimit = footprint.halfLengthMm + margin;
  const vLimit = footprint.halfWidthMm + margin;
  let minimum = 255;
  const base = map.levels[0];
  for (let row = r0; row <= r1; row += 1) {
    const y = map.origin[1] + row * map.stepMm - footprint.centerYmm;
    for (let column = c0; column <= c1; column += 1) {
      const x = map.origin[0] + column * map.stepMm - footprint.centerXmm;
      const u = x * cos + y * sin;
      if (u < -uLimit || u > uLimit) continue;
      const v = -x * sin + y * cos;
      if (v < -vLimit || v > vLimit) continue;
      const value = base[row * map.columns + column];
      if (value < minimum) minimum = value;
      if (minimum === 0) return 0;
    }
  }
  return minimum * map.quantizationMm;
}

export function componentBox(placement: ComponentPlacement, enclosure: EnclosureSpec): Box3D {
  const footprint = componentFootprint(placement);
  const corners = footprintCorners(footprint);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of corners) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const halfHeight = componentHalfHeight(placement);
  const centerZ = settleComponentCenterZ(enclosure, placement);
  if (!Number.isFinite(centerZ)) {
    // Unplaceable spot (over a wall / outside the grid): park the box above
    // the lid so it reads as outside instead of crashing the evaluation.
    const topZ = enclosure.dimensionsMm.height / 2;
    return { min: [minX, minY, topZ], max: [maxX, maxY, topZ + halfHeight * 2] };
  }
  return {
    min: [minX, minY, centerZ - halfHeight],
    max: [maxX, maxY, centerZ + halfHeight],
  };
}

function zRangesOverlap(a: Box3D, b: Box3D): boolean {
  return a.min[2] < b.max[2] && a.max[2] > b.min[2];
}

export function evaluateWorkspace(
  enclosure: EnclosureSpec,
  plan: PackPlan,
  components: ComponentPlacement[],
): WorkspaceEvaluation {
  const container = enclosureBounds(enclosure);
  const packObstacles = [
    ...plan.blocks.map((block) => block.envelope),
    ...plan.serviceVolumes.map((v) => v.box),
  ];
  const footprints = components.map(componentFootprint);
  const boxes = components.map((placement) => componentBox(placement, enclosure));
  const topZ = container.max[2];
  const evaluated = components.map((component, index) => {
    const box = boxes[index];
    const footprint = footprints[index];
    const collidesPack = packObstacles.some(
      (obstacle) =>
        zRangesOverlap(box, obstacle) && footprintsIntersect(footprint, boxFootprint(obstacle)),
    );
    const collidesComponent = footprints.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        zRangesOverlap(box, boxes[otherIndex]) &&
        footprintsIntersect(footprint, other),
    );
    // componentBox already settles the (possibly pitched) part onto the floor
    // or parks it above the lid when unplaceable, so the lid plane and the
    // plan bounds are all that is left to verify.
    const outside =
      enclosure.kind === "box"
        ? !containsBox(container, box)
        : box.max[2] > topZ + EPSILON ||
          box.min[0] < container.min[0] - EPSILON ||
          box.max[0] > container.max[0] + EPSILON ||
          box.min[1] < container.min[1] - EPSILON ||
          box.max[1] > container.max[1] + EPSILON;
    return {
      id: component.id,
      box,
      collides: collidesPack || collidesComponent,
      outside,
    };
  });
  const allObstacles = [...packObstacles, ...boxes];
  const enclosureVolume = enclosureContainmentKernel.volume(enclosure);
  const occupiedVolume = unionVolumeMm3(container, allObstacles);
  const freeVolumeMm3 = Math.max(0, enclosureVolume - occupiedVolume);
  // The largest free box is only meaningful for a rectangular enclosure; the
  // profiled case is validated through the height map instead.
  const largestFreeBox =
    enclosure.kind === "box"
      ? largestEmptyAxisAlignedBox(container, allObstacles)
      : { box: boxFromCenterSize([0, 0, 0], [0, 0, 0]), volumeMm3: 0 };
  return {
    components: evaluated,
    hasCollision: evaluated.some((item) => item.collides || item.outside),
    freeVolumeMm3,
    freePercent: (freeVolumeMm3 / enclosureVolume) * 100,
    largestFreeBox,
  };
}
