import {
  boxFromCenterSize,
  boxSize,
  boxVolume,
  cylinderTopLimitZ,
  distance,
  enclosureContainmentKernel,
  enclosureBounds,
  expandBox,
  largestEmptyAxisAlignedBox,
  minCylinderCenterZ,
  unionBoxes,
} from "./geometry";
import { activeServiceReservations } from "./service-reservations";
import type {
  Axis,
  Box3D,
  CellOrientation,
  EnumerationRequest,
  EnumerationResponse,
  LayoutMetrics,
  MeshHeightMapEnclosureSpec,
  PackFace,
  PackPlan,
  PackingMode,
  PlacementAnchor,
  SeriesGroup,
  ServiceReservation,
  ServiceVolume,
  ToleranceLayer,
  Vec3,
} from "./types";

const AXES: Axis[] = ["x", "y", "z"];
const AXIS_INDEX: Record<Axis, number> = { x: 0, y: 1, z: 2 };
const ANCHORS: PlacementAnchor[] = ["tail", "center", "nose"];
const PROFILE_PLACEMENT_STEP_MM = 2;
const SLIDE_STEP_MM = 0.25;
const SLIDE_MAX_MM = 30;
const HEX_ROW_FACTOR = Math.sqrt(3) / 2;
const EPSILON = 1e-6;
const ROUTE_ORDERS: Vec3[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

interface CompiledTolerances {
  radial: number;
  axialPerEnd: number;
  betweenCells: number;
  betweenLayers: number;
  betweenGroups: number;
  outerWrap: number;
}

interface GroupTemplate {
  centers: Vec3[];
  reservationSize: Vec3;
  /** Single-cell reservation size: sleeved cell plus radial/axial tolerance layers. */
  reservationCellSize: Vec3;
  /** Center-to-center pitch inside a group (reservation size plus compound gap). */
  cellPitch: Vec3;
}

interface CrossGroupStagger {
  rowAxis: number;
  shiftAxis: number;
  rowPitchMm: number;
  shiftMm: number;
}

interface LocalGroup {
  id: string;
  grid: Vec3;
  center: Vec3;
  cellPositions: Vec3[];
}

export function factorTriples(value: number): Vec3[] {
  const result: Vec3[] = [];
  for (let x = 1; x <= value; x += 1) {
    if (value % x !== 0) continue;
    const remaining = value / x;
    for (let y = 1; y <= remaining; y += 1) {
      if (remaining % y !== 0) continue;
      result.push([x, y, remaining / y]);
    }
  }
  return result;
}

function sumTolerance(stack: ToleranceLayer[], application: ToleranceLayer["application"]): number {
  return stack
    .filter((layer) => layer.application === application)
    .reduce((sum, layer) => sum + Math.max(0, layer.thicknessMm), 0);
}

function compileTolerances(stack: ToleranceLayer[]): CompiledTolerances {
  return {
    radial: sumTolerance(stack, "radial"),
    axialPerEnd: sumTolerance(stack, "axial-ends"),
    betweenCells: sumTolerance(stack, "between-cells"),
    betweenLayers: sumTolerance(stack, "between-layers"),
    betweenGroups: sumTolerance(stack, "between-groups"),
    outerWrap: sumTolerance(stack, "all-faces"),
  };
}

function cellSizeForOrientation(
  orientation: CellOrientation,
  diameter: number,
  height: number,
): Vec3 {
  const size: Vec3 = [diameter, diameter, diameter];
  size[AXIS_INDEX[orientation]] = height;
  return size;
}

function makeGroupTemplate(
  factors: Vec3,
  actualCellSize: Vec3,
  orientation: CellOrientation,
  mode: PackingMode,
  staggerRowAxis: Axis | undefined,
  tolerances: CompiledTolerances,
): GroupTemplate {
  const axialAxis = AXIS_INDEX[orientation];
  const reservationCellSize: Vec3 = actualCellSize.map((value, axis) =>
    axis === axialAxis ? value + tolerances.axialPerEnd * 2 : value + tolerances.radial * 2,
  ) as Vec3;
  const pitch = reservationCellSize.map((value) => value + tolerances.betweenCells) as Vec3;
  const rowAxis = staggerRowAxis === undefined ? -1 : AXIS_INDEX[staggerRowAxis];
  const radialAxes = [0, 1, 2].filter((axis) => axis !== axialAxis);
  const shiftAxis = radialAxes.find((axis) => axis !== rowAxis) ?? -1;
  const centers: Vec3[] = [];

  for (let x = 0; x < factors[0]; x += 1) {
    for (let y = 0; y < factors[1]; y += 1) {
      for (let z = 0; z < factors[2]; z += 1) {
        const grid: Vec3 = [x, y, z];
        const position: Vec3 = [x * pitch[0], y * pitch[1], z * pitch[2]];
        if (mode === "staggered" && rowAxis >= 0 && shiftAxis >= 0) {
          // Hex nesting pitch, optionally relaxed vertically by the
          // between-layers tolerance so holder walls can be thickened.
          position[rowAxis] =
            grid[rowAxis] * (pitch[rowAxis] * (Math.sqrt(3) / 2) + tolerances.betweenLayers);
          position[shiftAxis] += (grid[rowAxis] % 2) * pitch[shiftAxis] * 0.5;
        }
        centers.push(position);
      }
    }
  }

  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const center of centers) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], center[axis] - reservationCellSize[axis] / 2);
      max[axis] = Math.max(max[axis], center[axis] + reservationCellSize[axis] / 2);
    }
  }
  const normalized = centers.map(
    (center) => center.map((value, axis) => value - min[axis]) as Vec3,
  );
  return {
    centers: normalized,
    reservationSize: max.map((value, axis) => value - min[axis]) as Vec3,
    reservationCellSize,
    cellPitch: pitch,
  };
}

function createLocalGroups(
  seriesFactors: Vec3,
  template: GroupTemplate,
  betweenGroups: number,
  stagger?: CrossGroupStagger,
): LocalGroup[] {
  const pitch = template.reservationSize.map((value) => value + betweenGroups) as Vec3;
  const groups: LocalGroup[] = [];
  for (let x = 0; x < seriesFactors[0]; x += 1) {
    for (let y = 0; y < seriesFactors[1]; y += 1) {
      for (let z = 0; z < seriesFactors[2]; z += 1) {
        const grid: Vec3 = [x, y, z];
        const origin: Vec3 = [x * pitch[0], y * pitch[1], z * pitch[2]];
        if (stagger) {
          // Nest single-cell-thick group rows like a hex lattice: compressed
          // row pitch, odd rows shifted by half a cell pitch sideways.
          const rowIndex = grid[stagger.rowAxis];
          origin[stagger.rowAxis] = rowIndex * stagger.rowPitchMm;
          origin[stagger.shiftAxis] += (rowIndex % 2) * stagger.shiftMm;
        }
        const cellPositions = template.centers.map(
          (center) => center.map((value, axis) => value + origin[axis]) as Vec3,
        );
        const center = cellPositions
          .reduce<Vec3>(
            (sum, position) => [sum[0] + position[0], sum[1] + position[1], sum[2] + position[2]],
            [0, 0, 0],
          )
          .map((value) => value / cellPositions.length) as Vec3;
        groups.push({ id: `g-${x}-${y}-${z}`, grid, center, cellPositions });
      }
    }
  }
  return groups;
}

function serpentineCoordinates(dimensions: Vec3, order: Vec3): Vec3[] {
  function recurse(depth: number): Vec3[] {
    const axis = order[depth];
    if (depth === order.length - 1) {
      return Array.from({ length: dimensions[axis] }, (_, value) => {
        const coordinate: Vec3 = [0, 0, 0];
        coordinate[axis] = value;
        return coordinate;
      });
    }
    const inner = recurse(depth + 1);
    const result: Vec3[] = [];
    for (let value = 0; value < dimensions[axis]; value += 1) {
      const path = value % 2 === 0 ? inner : [...inner].reverse();
      for (const coordinate of path) {
        const next: Vec3 = [...coordinate];
        next[axis] = value;
        result.push(next);
      }
    }
    return result;
  }
  return recurse(0);
}

function routeGroups(groups: LocalGroup[], dimensions: Vec3): LocalGroup[] {
  const byGrid = new Map(groups.map((group) => [group.grid.join(":"), group]));
  let best = groups;
  let bestLength = Infinity;
  for (const order of ROUTE_ORDERS) {
    const route = serpentineCoordinates(dimensions, order).map(
      (coordinate) => byGrid.get(coordinate.join(":"))!,
    );
    const length = route
      .slice(1)
      .reduce((sum, group, index) => sum + distance(route[index].center, group.center), 0);
    if (length < bestLength) {
      best = route;
      bestLength = length;
    }
  }
  return best;
}

function serviceBoxForEnvelope(reservation: ServiceReservation, envelope: Box3D): Box3D {
  const envelopeCenter: Vec3 = [
    (envelope.min[0] + envelope.max[0]) / 2,
    (envelope.min[1] + envelope.max[1]) / 2,
    (envelope.min[2] + envelope.max[2]) / 2,
  ];
  const center: Vec3 = [...envelopeCenter];
  const faceAxis = reservation.face.endsWith("x") ? 0 : 1;
  const tangentAxis = faceAxis === 0 ? 1 : 0;
  const positive = reservation.face.startsWith("positive");
  center[faceAxis] = positive
    ? envelope.max[faceAxis] + reservation.sizeMm[faceAxis] / 2
    : envelope.min[faceAxis] - reservation.sizeMm[faceAxis] / 2;
  const offset = reservation.offsetMm ?? [0, 0, 0];
  const faceLength = envelope.max[tangentAxis] - envelope.min[tangentAxis];
  const tangentLimit = Math.max(0, (faceLength - reservation.sizeMm[tangentAxis]) / 2);
  center[tangentAxis] += Math.max(-tangentLimit, Math.min(tangentLimit, offset[tangentAxis]));
  return boxFromCenterSize(center, reservation.sizeMm);
}

function anchorOffset(bounds: Box3D, enclosure: Box3D, anchor: PlacementAnchor): Vec3 {
  const boundsCenterY = (bounds.min[1] + bounds.max[1]) / 2;
  let x = -(bounds.min[0] + bounds.max[0]) / 2;
  if (anchor === "tail") x = enclosure.min[0] - bounds.min[0];
  if (anchor === "nose") x = enclosure.max[0] - bounds.max[0];
  return [x, -boundsCenterY, enclosure.min[2] - bounds.min[2]];
}

interface ProfilePlacementRequest {
  spec: MeshHeightMapEnclosureSpec;
  container: Box3D;
  localBounds: Box3D;
  localCells: Vec3[];
  /** Lattice layer of every local cell. */
  cellLayers: number[];
  /** Center distance at which two cells of adjacent layers touch. */
  supportDistanceMm: number;
  /**
   * Settle the lattice as one rigid body instead of draping columns. Brick
   * packs stack cells vertically, so a column riding a ramp would push its
   * whole tower up; only staggered lattices benefit from per-column settling.
   */
  rigid: boolean;
  axialIndex: number;
  orientation: CellOrientation;
  cylinderRadiusMm: number;
  cylinderHalfLengthMm: number;
}

export interface ProfilePlacement {
  anchor: PlacementAnchor;
  xOffset: number;
  yOffset: number;
  /** Final z of every local cell: the lattice drapes over the terrain. */
  cellZ: number[];
  /**
   * Per-cell x adjustment: an edge column that would push its upper
   * neighbours up instead slides outward along the ramp until it clears them.
   */
  cellDX?: number[];
}

/**
 * Scan x positions along the deck and drape the lattice over the exact inner
 * surface: every bottom-layer cell settles onto its own floor as a cylinder,
 * and each upper cell rests on its actual neighbours, preserving the vertical
 * spacing of the lattice pair-wise. An edge column riding a ramp therefore
 * lifts only itself and its direct dependents instead of the whole pack. Out
 * of all feasible positions only representatives are kept: tail-most,
 * nose-most, the one closest to the deck center, and the deepest.
 */
function profilePlacements(request: ProfilePlacementRequest): {
  placements: ProfilePlacement[];
  scannedCount: number;
} {
  const { spec, container, localBounds, localCells, cellLayers, axialIndex, orientation } = request;
  const lateralIndex = axialIndex === 0 ? 1 : 0;
  const tailX = container.min[0] - localBounds.min[0];
  const noseX = container.max[0] - localBounds.max[0];
  if (tailX > noseX) return { placements: [], scannedCount: 0 };
  const xOffsets = new Set<number>([tailX, noseX]);
  if (tailX < 0 && noseX > 0) xOffsets.add(0);
  for (let x = tailX; x <= noseX + EPSILON; x += PROFILE_PLACEMENT_STEP_MM) {
    xOffsets.add(Math.min(noseX, x));
  }
  const yOffset = -(localBounds.min[1] + localBounds.max[1]) / 2;
  const layerCount = Math.max(...cellLayers) + 1;
  const byLayer: number[][] = Array.from({ length: layerCount }, () => []);
  cellLayers.forEach((layer, index) => byLayer[layer].push(index));

  // Support pairs from the undraped lattice: an upper cell keeps at least its
  // original vertical spacing to every lower neighbour it actually rests on,
  // i.e. pairs at lattice touch distance - not farther diagonal neighbours.
  const supports: Array<
    Array<{ lower: number; riseMm: number; lateralMm: number; touchMm: number }>
  > = localCells.map(() => []);
  for (let layer = 1; layer < layerCount; layer += 1) {
    for (const upper of byLayer[layer]) {
      for (const lower of byLayer[layer - 1]) {
        if (Math.abs(localCells[upper][axialIndex] - localCells[lower][axialIndex]) > 1) continue;
        const lateral = Math.abs(localCells[upper][lateralIndex] - localCells[lower][lateralIndex]);
        const rise = localCells[upper][2] - localCells[lower][2];
        const touch = Math.hypot(lateral, rise);
        if (touch > request.supportDistanceMm) continue;
        supports[upper].push({ lower, riseMm: rise, lateralMm: lateral, touchMm: touch });
      }
    }
  }

  const topLimitZ = cylinderTopLimitZ(spec, {
    centerXmm: 0,
    centerYmm: 0,
    axis: orientation,
    radiusMm: request.cylinderRadiusMm,
    halfLengthMm: request.cylinderHalfLengthMm,
  });

  const ownFloor = (index: number, x: number, shiftMm: number): number =>
    minCylinderCenterZ(spec, {
      centerXmm: localCells[index][0] + x + shiftMm,
      centerYmm: localCells[index][1] + yOffset,
      axis: orientation,
      radiusMm: request.cylinderRadiusMm,
      halfLengthMm: request.cylinderHalfLengthMm,
    });

  /**
   * A bottom edge column pushed up by a ramp may instead slide outward along
   * it: once its lateral distance to the upper row reaches the lattice touch
   * distance the upper cells stay down, something the greedy drape cannot
   * express. Only lattices whose stagger step runs along the deck can relax
   * this way (a cylinder sliding along its own axis never clears its
   * neighbours), and only when every affected upper cell keeps another
   * support to rest on.
   */
  const slideEdgeColumns = (x: number, baseZ: number[]): { cellZ: number[]; dx: number[] } => {
    const dx = new Array<number>(localCells.length).fill(0);
    if (request.rigid || axialIndex === 0 || layerCount < 2) return { cellZ: baseZ, dx };
    const cellZ = [...baseZ];
    const bottom = byLayer[0];
    for (const dir of [-1, 1] as const) {
      const edgeX =
        dir === -1
          ? Math.min(...bottom.map((index) => localCells[index][0]))
          : Math.max(...bottom.map((index) => localCells[index][0]));
      const column = bottom.filter((index) => Math.abs(localCells[index][0] - edgeX) < 1e-6);
      const columnSet = new Set(column);
      const dependents: Array<{
        upper: number;
        lower: number;
        lateralMm: number;
        touchMm: number;
      }> = [];
      for (const upper of byLayer[1]) {
        for (const pair of supports[upper]) {
          if (!columnSet.has(pair.lower)) continue;
          dependents.push({
            upper,
            lower: pair.lower,
            lateralMm: pair.lateralMm,
            touchMm: pair.touchMm,
          });
        }
      }
      if (dependents.length === 0) continue;
      // An upper cell whose only support is the sliding column would drop
      // into the vacated groove; keep the plain lift for that shape.
      if (dependents.some((item) => supports[item.upper].length < 2)) continue;
      const upperBase = new Map<number, number>();
      for (const upper of new Set(dependents.map((item) => item.upper))) {
        let base = ownFloor(upper, x, 0);
        for (const pair of supports[upper]) {
          if (!columnSet.has(pair.lower)) base = Math.max(base, cellZ[pair.lower] + pair.riseMm);
        }
        if (!Number.isFinite(base)) return { cellZ: baseZ, dx };
        upperBase.set(upper, base);
      }
      const pushes = dependents.some(
        (item) => cellZ[item.upper] > (upperBase.get(item.upper) ?? Infinity) + EPSILON,
      );
      if (!pushes) continue;
      search: for (
        let shift = SLIDE_STEP_MM;
        shift <= SLIDE_MAX_MM + EPSILON;
        shift += SLIDE_STEP_MM
      ) {
        const slidZ = new Map<number, number>();
        for (const index of column) {
          const floorZ = ownFloor(index, x, dir * shift);
          if (!Number.isFinite(floorZ) || floorZ > topLimitZ) break search;
          slidZ.set(index, floorZ);
        }
        let clears = true;
        for (const item of dependents) {
          const lateral = item.lateralMm + shift;
          if (lateral >= item.touchMm) continue;
          const rise = Math.sqrt(item.touchMm ** 2 - lateral ** 2);
          const lowerZ = slidZ.get(item.lower) ?? -Infinity;
          if (lowerZ + rise > (upperBase.get(item.upper) ?? -Infinity) + EPSILON) {
            clears = false;
            break;
          }
        }
        if (!clears) continue;
        for (const index of column) {
          dx[index] = dir * shift;
          cellZ[index] = slidZ.get(index)!;
        }
        for (const [upper, base] of upperBase) cellZ[upper] = base;
        break;
      }
    }
    return { cellZ, dx };
  };

  const nearMisses: Array<{ x: number; overflow: number }> = [];
  let nearMissX: number | undefined;
  let nearMissOverflow = Infinity;
  const evaluate = (x: number): { x: number; cellZ: number[]; restMm: number } | undefined => {
    const cellZ = new Array<number>(localCells.length).fill(-Infinity);
    let highest = -Infinity;
    if (request.rigid) {
      let liftMm = -Infinity;
      for (const [index, cell] of localCells.entries()) {
        const floorZ = minCylinderCenterZ(spec, {
          centerXmm: cell[0] + x,
          centerYmm: cell[1] + yOffset,
          axis: orientation,
          radiusMm: request.cylinderRadiusMm,
          halfLengthMm: request.cylinderHalfLengthMm,
        });
        if (!Number.isFinite(floorZ)) return undefined;
        liftMm = Math.max(liftMm, floorZ - localCells[index][2]);
      }
      for (const [index, cell] of localCells.entries()) {
        cellZ[index] = cell[2] + liftMm;
        highest = Math.max(highest, cellZ[index]);
      }
    } else {
      for (let layer = 0; layer < layerCount; layer += 1) {
        for (const index of byLayer[layer]) {
          const cell = localCells[index];
          const floorZ = minCylinderCenterZ(spec, {
            centerXmm: cell[0] + x,
            centerYmm: cell[1] + yOffset,
            axis: orientation,
            radiusMm: request.cylinderRadiusMm,
            halfLengthMm: request.cylinderHalfLengthMm,
          });
          if (!Number.isFinite(floorZ)) return undefined;
          let z = floorZ;
          for (const support of supports[index]) {
            z = Math.max(z, cellZ[support.lower] + support.riseMm);
          }
          cellZ[index] = z;
          highest = Math.max(highest, z);
        }
      }
    }
    const overflow = highest - topLimitZ;
    if (overflow > EPSILON) {
      // Remember the least-bad spots: feasibility windows narrower than the
      // scan step hide between grid points and are recovered by refining.
      nearMisses.push({ x, overflow });
      if (overflow < nearMissOverflow) {
        nearMissOverflow = overflow;
        nearMissX = x;
      }
      return undefined;
    }
    const restMm =
      byLayer[0].reduce((sum, index) => sum + cellZ[index], 0) / Math.max(1, byLayer[0].length);
    return { x, cellZ, restMm };
  };

  type Candidate = { x: number; cellZ: number[]; restMm: number };
  const feasible: Candidate[] = [];
  const scanned = [...xOffsets].sort((a, b) => a - b);
  for (const x of scanned) {
    const candidate = evaluate(x);
    if (candidate) feasible.push(candidate);
  }
  // Windows narrower than the scan step hide between grid points: the
  // overflow landscape can have several local minima (one per ramp), so zoom
  // into the best few coarse near-misses, then once more around the best
  // refined spot.
  if (feasible.length === 0 && nearMisses.length > 0) {
    const seeds = [...nearMisses]
      .sort((a, b) => a.overflow - b.overflow)
      .slice(0, 4)
      .map((miss) => miss.x);
    for (const seed of seeds) {
      for (
        let x = seed - PROFILE_PLACEMENT_STEP_MM;
        x <= seed + PROFILE_PLACEMENT_STEP_MM;
        x += 0.25
      ) {
        if (x <= tailX || x >= noseX) continue;
        const candidate = evaluate(x);
        if (candidate) feasible.push(candidate);
      }
    }
    if (feasible.length === 0 && nearMissX !== undefined) {
      for (let x = nearMissX - 0.3; x <= nearMissX + 0.3 + EPSILON; x += 0.03) {
        if (x <= tailX || x >= noseX) continue;
        const candidate = evaluate(x);
        if (candidate) feasible.push(candidate);
      }
    }
  }
  if (feasible.length === 0) return { placements: [], scannedCount: scanned.length };

  // Refine around the deepest coarse hit so the pack truly rests on the floor
  // instead of stopping at the scan grid resolution.
  const coarseDeepest = feasible.reduce((best, candidate) =>
    candidate.restMm < best.restMm ? candidate : best,
  );
  for (
    let x = coarseDeepest.x - PROFILE_PLACEMENT_STEP_MM + 0.5;
    x < coarseDeepest.x + PROFILE_PLACEMENT_STEP_MM;
    x += 0.5
  ) {
    if (x <= tailX || x >= noseX) continue;
    const candidate = evaluate(x);
    if (candidate) feasible.push(candidate);
  }
  feasible.sort((a, b) => a.x - b.x);

  const byDistanceToZero = [...feasible].sort((a, b) => Math.abs(a.x) - Math.abs(b.x));
  const deepest = [...feasible].sort(
    (a, b) => a.restMm - b.restMm || Math.abs(a.x) - Math.abs(b.x),
  )[0];
  const representatives = new Map<number, PlacementAnchor>();
  representatives.set(deepest.x, "profile");
  representatives.set(byDistanceToZero[0].x, "center");
  representatives.set(feasible[feasible.length - 1].x, "nose");
  representatives.set(feasible[0].x, "tail");
  const placements = [...representatives.entries()]
    .sort(([a], [b]) => a - b)
    .map(([x, anchor]) => {
      const candidate = feasible.find((item) => item.x === x)!;
      const slid = slideEdgeColumns(x, candidate.cellZ);
      return { anchor, xOffset: x, yOffset, cellZ: slid.cellZ, cellDX: slid.dx };
    });
  return { placements, scannedCount: scanned.length };
}

/** Wall and lid clearance for a settled pack; the floor contact itself is 0 by design. */
function profileClearance(container: Box3D, bounds: Box3D): number {
  return Math.min(
    bounds.min[0] - container.min[0],
    container.max[0] - bounds.max[0],
    bounds.min[1] - container.min[1],
    container.max[1] - bounds.max[1],
    container.max[2] - bounds.max[2],
  );
}

/**
 * Hard physical guard: no two cylinders may overlap, whatever lattice produced
 * them. Cells share one orientation, so a pair collides only when both the
 * axial spans and the radial cross-sections overlap.
 */
function cellsPhysicallySeparated(
  cells: Vec3[],
  axialAxis: number,
  radialMinMm: number,
  axialMinMm: number,
): boolean {
  const radialA = axialAxis === 0 ? 1 : 0;
  const radialB = axialAxis === 2 ? 1 : 2;
  const radialMinSq = Math.max(0, radialMinMm - 1e-3) ** 2;
  const axialMin = Math.max(0, axialMinMm - 1e-3);
  for (let i = 0; i < cells.length; i += 1) {
    for (let j = i + 1; j < cells.length; j += 1) {
      if (Math.abs(cells[i][axialAxis] - cells[j][axialAxis]) >= axialMin) continue;
      const da = cells[i][radialA] - cells[j][radialA];
      const db = cells[i][radialB] - cells[j][radialB];
      if (da * da + db * db < radialMinSq) return false;
    }
  }
  return true;
}

function metricShell(): LayoutMetrics {
  return {
    score: 0,
    centerOfMassXmm: 0,
    centerOfMassPercent: 50,
    centerOffsetMm: 0,
    seriesChainLengthMm: 0,
    minClearanceMm: 0,
    layerCount: 1,
    reservationVolumeMm3: 0,
    utilizationPercent: 0,
    largestFreeBox: { box: { min: [0, 0, 0], max: [0, 0, 0] }, volumeMm3: 0 },
    manufacturability: 100,
  };
}

function canonicalPlanKey(plan: PackPlan): string {
  const size = boxSize(plan.bounds).map((value) => value.toFixed(2));
  const center = plan.bounds.min.map((value, axis) =>
    ((value + plan.bounds.max[axis]) / 2).toFixed(2),
  );
  return [
    plan.orientation,
    plan.packingMode,
    plan.staggerRowAxis ?? "-",
    plan.parallelFactors.join("x"),
    plan.seriesFactors.join("x"),
    plan.anchor,
    center.join("x"),
    size.join("x"),
  ].join("|");
}

function range(values: number[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return [min, max];
}

function normalizedInverse(value: number, min: number, max: number): number {
  if (Math.abs(max - min) < 1e-9) return 1;
  return 1 - (value - min) / (max - min);
}

function normalized(value: number, min: number, max: number): number {
  if (Math.abs(max - min) < 1e-9) return 1;
  return (value - min) / (max - min);
}

function rankPlans(plans: PackPlan[]): PackPlan[] {
  if (plans.length === 0) return plans;
  const chainRange = range(plans.map((plan) => plan.metrics.seriesChainLengthMm));
  const centerRange = range(plans.map((plan) => plan.metrics.centerOffsetMm));
  const clearanceRange = range(plans.map((plan) => plan.metrics.minClearanceMm));
  const freeRange = range(plans.map((plan) => plan.metrics.largestFreeBox.volumeMm3));
  const envelopeRange = range(plans.map((plan) => boxVolume(plan.bounds)));
  for (const plan of plans) {
    const center = normalizedInverse(plan.metrics.centerOffsetMm, ...centerRange);
    const chain = normalizedInverse(plan.metrics.seriesChainLengthMm, ...chainRange);
    const clearance = normalized(plan.metrics.minClearanceMm, ...clearanceRange);
    const free = normalized(plan.metrics.largestFreeBox.volumeMm3, ...freeRange);
    const compact = normalizedInverse(boxVolume(plan.bounds), ...envelopeRange);
    const manufacturing = plan.metrics.manufacturability / 100;
    plan.metrics.score = Math.round(
      (center * 0.22 +
        chain * 0.18 +
        clearance * 0.15 +
        free * 0.15 +
        compact * 0.15 +
        manufacturing * 0.15) *
        100,
    );
  }
  return plans.sort(
    (a, b) =>
      b.metrics.score - a.metrics.score ||
      a.metrics.seriesChainLengthMm - b.metrics.seriesChainLengthMm,
  );
}

export function enumeratePackPlans(request: EnumerationRequest): EnumerationResponse {
  const { config, cell } = request;
  const { enclosure, pack } = config;
  const container = enclosureBounds(enclosure);
  const enclosureVolume = enclosureContainmentKernel.volume(enclosure);
  const tolerance = compileTolerances(pack.toleranceStack);
  const parallelFactors = factorTriples(pack.parallelCount);
  const seriesFactors = factorTriples(pack.seriesCount);
  const orientations = pack.orientation === "auto" ? AXES : [pack.orientation];
  const plans: PackPlan[] = [];
  const seen = new Set<string>();
  let exploredCount = 0;

  for (const orientation of orientations) {
    const axialAxis = AXIS_INDEX[orientation];
    const radialAxes = AXES.filter((axis) => AXIS_INDEX[axis] !== axialAxis);
    const actualCellSize = cellSizeForOrientation(
      orientation,
      cell.sleevedDiameterMm,
      cell.sleevedHeightMm,
    );
    for (const packingMode of pack.packingModes) {
      const staggerAxes: Array<Axis | undefined> =
        packingMode === "staggered" ? radialAxes : [undefined];
      for (const staggerRowAxis of staggerAxes) {
        const rowAxisIndex = staggerRowAxis === undefined ? -1 : AXIS_INDEX[staggerRowAxis];
        const shiftAxisIndex =
          rowAxisIndex >= 0
            ? radialAxes.map((axis) => AXIS_INDEX[axis]).find((axis) => axis !== rowAxisIndex)!
            : -1;
        for (const pFactors of parallelFactors) {
          const template = makeGroupTemplate(
            pFactors,
            actualCellSize,
            orientation,
            packingMode,
            staggerRowAxis,
            tolerance,
          );
          for (const sFactors of seriesFactors) {
            const staggerInGroup = rowAxisIndex >= 0 && pFactors[rowAxisIndex] > 1;
            const staggerAcrossGroups =
              rowAxisIndex >= 0 && pFactors[rowAxisIndex] === 1 && sFactors[rowAxisIndex] > 1;
            // A staggered lattice with a single row degenerates to the brick
            // grid; skip it so brick geometry is not duplicated with a
            // "custom holder" label and a worse manufacturability score.
            if (packingMode === "staggered" && !staggerInGroup && !staggerAcrossGroups) continue;
            const crossStagger: CrossGroupStagger | undefined = staggerAcrossGroups
              ? {
                  rowAxis: rowAxisIndex,
                  shiftAxis: shiftAxisIndex,
                  rowPitchMm:
                    template.cellPitch[rowAxisIndex] * HEX_ROW_FACTOR + tolerance.betweenLayers,
                  shiftMm: template.cellPitch[shiftAxisIndex] / 2,
                }
              : undefined;
            const localGroups = createLocalGroups(
              sFactors,
              template,
              tolerance.betweenGroups,
              crossStagger,
            );
            const allLocalCells = localGroups.flatMap((group) => group.cellPositions);
            // Lattice layers are identified from the undraped local z values;
            // the settled heights may differ per cell once draped over terrain.
            const distinctLocalZ = [
              ...new Set(allLocalCells.map((position) => Math.round(position[2] * 100) / 100)),
            ].sort((a, b) => a - b);
            const latticeLayerCount = distinctLocalZ.length;
            if (latticeLayerCount > pack.maxLayers) continue;
            const cellLayers = allLocalCells.map((position) =>
              distinctLocalZ.findIndex((value) => Math.abs(value - position[2]) < 0.02),
            );

            const { reservationCellSize } = template;
            if (
              !cellsPhysicallySeparated(
                allLocalCells,
                axialAxis,
                reservationCellSize[axialAxis === 0 ? 1 : 0],
                reservationCellSize[axialAxis],
              )
            )
              continue;
            const routed = routeGroups(localGroups, sFactors);
            const cellBoxes = allLocalCells.map((position) =>
              boxFromCenterSize(position, reservationCellSize),
            );
            const occupied = unionBoxes(cellBoxes);
            const blockEnvelope = expandBox(occupied, [
              tolerance.outerWrap,
              tolerance.outerWrap,
              tolerance.outerWrap,
            ]);
            const activeReservations = activeServiceReservations(pack).filter(
              (reservation) => reservation.enabled,
            );
            const localServiceVolumes: ServiceVolume[] = activeReservations.map((reservation) => ({
              id: reservation.id,
              label: reservation.label,
              kind: reservation.kind,
              box: serviceBoxForEnvelope(reservation, blockEnvelope),
            }));
            const localBounds = unionBoxes([
              blockEnvelope,
              ...localServiceVolumes.map((v) => v.box),
            ]);
            const requiredSize = boxSize(localBounds);
            const enclosureSize: Vec3 = [
              enclosure.dimensionsMm.length,
              enclosure.dimensionsMm.width,
              enclosure.dimensionsMm.height,
            ];
            if (requiredSize.some((value, axis) => value > enclosureSize[axis] + 1e-6)) continue;

            let placements: ProfilePlacement[];
            if (enclosure.kind === "box") {
              placements = ANCHORS.map((anchor) => {
                const offset = anchorOffset(localBounds, container, anchor);
                return {
                  anchor,
                  xOffset: offset[0],
                  yOffset: offset[1],
                  cellZ: allLocalCells.map((position) => position[2] + offset[2]),
                };
              });
              exploredCount += placements.length;
            } else {
              const profiled = profilePlacements({
                spec: enclosure,
                container,
                localBounds,
                localCells: allLocalCells,
                cellLayers,
                axialIndex: axialAxis,
                orientation,
                cylinderRadiusMm:
                  reservationCellSize[axialAxis === 0 ? 1 : 0] / 2 + tolerance.outerWrap,
                cylinderHalfLengthMm: reservationCellSize[axialAxis] / 2 + tolerance.outerWrap,
                supportDistanceMm:
                  Math.max(
                    template.cellPitch[axialAxis === 0 ? 1 : 0],
                    template.reservationSize[2] + tolerance.betweenGroups,
                  ) + 0.6,
                rigid: packingMode === "brick",
              });
              placements = profiled.placements;
              exploredCount += profiled.scannedCount;
            }
            const groupStarts: number[] = [];
            {
              let cursor = 0;
              for (const group of localGroups) {
                groupStarts.push(cursor);
                cursor += group.cellPositions.length;
              }
            }
            for (const placement of placements) {
              const { anchor } = placement;
              const finalPositions: Vec3[] = allLocalCells.map((position, index) => [
                position[0] + placement.xOffset + (placement.cellDX?.[index] ?? 0),
                position[1] + placement.yOffset,
                placement.cellZ[index],
              ]);
              // Draping preserves lattice spacing pair-wise; this guards the
              // invariant against future regressions.
              if (
                !cellsPhysicallySeparated(
                  finalPositions,
                  axialAxis,
                  reservationCellSize[axialAxis === 0 ? 1 : 0],
                  reservationCellSize[axialAxis],
                )
              )
                continue;
              const translatedBlock = expandBox(
                unionBoxes(
                  finalPositions.map((position) =>
                    boxFromCenterSize(position, reservationCellSize),
                  ),
                ),
                [tolerance.outerWrap, tolerance.outerWrap, tolerance.outerWrap],
              );
              const translatedServices = localServiceVolumes.map((volume, index) => ({
                ...volume,
                box: serviceBoxForEnvelope(activeReservations[index], translatedBlock),
              }));
              const bounds = unionBoxes([
                translatedBlock,
                ...translatedServices.map((volume) => volume.box),
              ]);
              // For a box every bound is checked at once; for the profiled
              // case the cells passed the exact cylinder check while draping,
              // so only the attached service volumes remain to verify.
              if (enclosure.kind === "box") {
                if (!enclosureContainmentKernel.contains(enclosure, bounds)) continue;
              } else if (
                !translatedServices.every((volume) =>
                  enclosureContainmentKernel.contains(enclosure, volume.box),
                )
              )
                continue;

              const groupCenterById = new Map<string, Vec3>();
              localGroups.forEach((group, groupIndex) => {
                const start = groupStarts[groupIndex];
                const center: Vec3 = [0, 0, 0];
                group.cellPositions.forEach((_, cellIndex) => {
                  const position = finalPositions[start + cellIndex];
                  center[0] += position[0];
                  center[1] += position[1];
                  center[2] += position[2];
                });
                groupCenterById.set(
                  group.id,
                  center.map((value) => value / group.cellPositions.length) as Vec3,
                );
              });
              const orderedGroups: SeriesGroup[] = routed.map((group, seriesIndex) => ({
                id: group.id,
                seriesIndex,
                grid: group.grid,
                center: groupCenterById.get(group.id)!,
                cellIds: group.cellPositions.map((_, cellIndex) => `${group.id}-c${cellIndex}`),
              }));
              const seriesById = new Map(
                orderedGroups.map((group) => [group.id, group.seriesIndex]),
              );
              const cells = localGroups.flatMap((group, groupIndex) =>
                group.cellPositions.map((_, cellIndex) => ({
                  id: `${group.id}-c${cellIndex}`,
                  groupId: group.id,
                  seriesIndex: seriesById.get(group.id)!,
                  layer: cellLayers[groupStarts[groupIndex] + cellIndex],
                  position: finalPositions[groupStarts[groupIndex] + cellIndex],
                })),
              );
              const seriesPath = orderedGroups.map((group) => group.center);
              const centerOfMassXmm =
                cells.reduce((sum, placedCell) => sum + placedCell.position[0], 0) / cells.length;
              const seriesChainLengthMm = seriesPath
                .slice(1)
                .reduce((sum, point, index) => sum + distance(seriesPath[index], point), 0);
              const obstacles = [
                translatedBlock,
                ...translatedServices.map((volume) => volume.box),
              ];
              const reservationVolumeMm3 = obstacles.reduce(
                (sum, obstacle) => sum + boxVolume(obstacle),
                0,
              );
              const metrics: LayoutMetrics = {
                ...metricShell(),
                centerOfMassXmm,
                centerOfMassPercent:
                  ((centerOfMassXmm + enclosure.dimensionsMm.length / 2) /
                    enclosure.dimensionsMm.length) *
                  100,
                centerOffsetMm: Math.abs(centerOfMassXmm - pack.targetCenterOfMassXmm),
                seriesChainLengthMm,
                minClearanceMm:
                  enclosure.kind === "box"
                    ? enclosureContainmentKernel.clearance(enclosure, bounds)
                    : profileClearance(container, bounds),
                layerCount: latticeLayerCount,
                reservationVolumeMm3,
                utilizationPercent: (reservationVolumeMm3 / enclosureVolume) * 100,
                largestFreeBox:
                  enclosure.kind === "box"
                    ? largestEmptyAxisAlignedBox(container, obstacles)
                    : metricShell().largestFreeBox,
                manufacturability: Math.max(
                  0,
                  100 - (packingMode === "staggered" ? 25 : 0) - (latticeLayerCount - 1) * 8,
                ),
              };
              const plan: PackPlan = {
                id: "",
                packingMode,
                orientation,
                staggerRowAxis,
                parallelFactors: pFactors,
                seriesFactors: sFactors,
                anchor,
                cellSizeMm: actualCellSize,
                cells,
                groups: orderedGroups,
                seriesOrder: orderedGroups.map((group) => group.id),
                seriesPath,
                blocks: [
                  {
                    id: "block-0",
                    groupIds: orderedGroups.map((group) => group.id),
                    envelope: translatedBlock,
                  },
                ],
                serviceVolumes: translatedServices,
                bounds,
                metrics,
              };
              const key = canonicalPlanKey(plan);
              if (seen.has(key)) continue;
              seen.add(key);
              plan.id = `layout-${seen.size}-${Math.abs(hashString(key))}`;
              plans.push(plan);
            }
          }
        }
      }
    }
  }
  return { plans: rankPlans(plans), exploredCount };
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash;
}

export function formatFactors(factors: Vec3): string {
  return factors.join("×");
}

/**
 * Stable identity of a lattice choice: survives tolerance and enclosure edits
 * that reshuffle plan ids, so the UI can keep the user's selection.
 */
export function planSignature(plan: PackPlan): string {
  return [
    plan.packingMode,
    plan.orientation,
    plan.staggerRowAxis ?? "-",
    plan.parallelFactors.join("x"),
    plan.seriesFactors.join("x"),
    plan.anchor,
  ].join("|");
}

export function faceAxis(face: PackFace): Axis {
  return face.endsWith("x") ? "x" : "y";
}
