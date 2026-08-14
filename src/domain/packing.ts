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
  translateBox,
  unionBoxes,
  type ProfileCylinder,
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
          position[rowAxis] = grid[rowAxis] * pitch[rowAxis] * (Math.sqrt(3) / 2);
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
  orientation: CellOrientation;
  cylinderRadiusMm: number;
  cylinderHalfLengthMm: number;
  localServiceBoxes: Box3D[];
}

/**
 * Scan x positions along the deck and let the pack settle onto the exact inner
 * surface like a rigid body dropped vertically: every cell is checked as a
 * cylinder, so the pack rests on the deep floor and may overhang a ramp as long
 * as the curved undersides genuinely clear it. Out of all feasible positions
 * only representatives are kept: tail-most, nose-most, the one closest to the
 * deck center, and the one that settles deepest.
 */
function profilePlacements(request: ProfilePlacementRequest): {
  placements: Array<{ anchor: PlacementAnchor; offset: Vec3 }>;
  scannedCount: number;
} {
  const { spec, container, localBounds, localCells, orientation } = request;
  const tailX = container.min[0] - localBounds.min[0];
  const noseX = container.max[0] - localBounds.max[0];
  if (tailX > noseX) return { placements: [], scannedCount: 0 };
  const xOffsets = new Set<number>([tailX, noseX]);
  if (tailX < 0 && noseX > 0) xOffsets.add(0);
  for (let x = tailX; x <= noseX + EPSILON; x += PROFILE_PLACEMENT_STEP_MM) {
    xOffsets.add(Math.min(noseX, x));
  }
  const yOffset = -(localBounds.min[1] + localBounds.max[1]) / 2;

  // Only the lowest cell of each vertical column can touch the floor first.
  const columns = new Map<string, Vec3>();
  let highestLocalZ = -Infinity;
  for (const cell of localCells) {
    const key = `${cell[0].toFixed(3)}:${cell[1].toFixed(3)}`;
    const existing = columns.get(key);
    if (!existing || cell[2] < existing[2]) columns.set(key, cell);
    highestLocalZ = Math.max(highestLocalZ, cell[2]);
  }
  const bottomCells = [...columns.values()];
  const topLimitZ = cylinderTopLimitZ(spec, {
    centerXmm: 0,
    centerYmm: 0,
    axis: orientation,
    radiusMm: request.cylinderRadiusMm,
    halfLengthMm: request.cylinderHalfLengthMm,
  });

  const evaluate = (x: number): { x: number; zOffset: number } | undefined => {
    let zOffset = -Infinity;
    for (const cell of bottomCells) {
      const cylinder: ProfileCylinder = {
        centerXmm: cell[0] + x,
        centerYmm: cell[1] + yOffset,
        axis: orientation,
        radiusMm: request.cylinderRadiusMm,
        halfLengthMm: request.cylinderHalfLengthMm,
      };
      const minCenterZ = minCylinderCenterZ(spec, cylinder);
      if (!Number.isFinite(minCenterZ)) return undefined;
      zOffset = Math.max(zOffset, minCenterZ - cell[2]);
    }
    if (highestLocalZ + zOffset > topLimitZ + EPSILON) return undefined;
    const servicesFit = request.localServiceBoxes.every((box) =>
      enclosureContainmentKernel.contains(spec, translateBox(box, [x, yOffset, zOffset])),
    );
    return servicesFit ? { x, zOffset } : undefined;
  };

  const feasible: Array<{ x: number; zOffset: number }> = [];
  const scanned = [...xOffsets].sort((a, b) => a - b);
  for (const x of scanned) {
    const candidate = evaluate(x);
    if (candidate) feasible.push(candidate);
  }
  if (feasible.length === 0) return { placements: [], scannedCount: scanned.length };

  // Refine around the deepest coarse hit so the pack truly rests on the floor
  // instead of stopping at the scan grid resolution.
  const coarseDeepest = feasible.reduce((best, candidate) =>
    candidate.zOffset < best.zOffset ? candidate : best,
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
    (a, b) => a.zOffset - b.zOffset || Math.abs(a.x) - Math.abs(b.x),
  )[0];
  const representatives = new Map<number, PlacementAnchor>();
  representatives.set(deepest.x, "profile");
  representatives.set(byDistanceToZero[0].x, "center");
  representatives.set(feasible[feasible.length - 1].x, "nose");
  representatives.set(feasible[0].x, "tail");
  const placements = [...representatives.entries()]
    .sort(([a], [b]) => a - b)
    .map(([x, anchor]) => {
      const zOffset = feasible.find((candidate) => candidate.x === x)!.zOffset;
      return { anchor, offset: [x, yOffset, zOffset] as Vec3 };
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

function uniqueLayerCount(cells: Vec3[]): number {
  return new Set(cells.map((position) => position[2].toFixed(3))).size;
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
                  rowPitchMm: template.cellPitch[rowAxisIndex] * HEX_ROW_FACTOR,
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
            if (uniqueLayerCount(allLocalCells) > pack.maxLayers) continue;

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
            const localServiceVolumes: ServiceVolume[] = activeServiceReservations(pack)
              .filter((reservation) => reservation.enabled)
              .map((reservation) => ({
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

            let placements: Array<{ anchor: PlacementAnchor; offset: Vec3 }>;
            if (enclosure.kind === "box") {
              placements = ANCHORS.map((anchor) => ({
                anchor,
                offset: anchorOffset(localBounds, container, anchor),
              }));
              exploredCount += placements.length;
            } else {
              const profiled = profilePlacements({
                spec: enclosure,
                container,
                localBounds,
                localCells: allLocalCells,
                orientation,
                cylinderRadiusMm:
                  reservationCellSize[axialAxis === 0 ? 1 : 0] / 2 + tolerance.outerWrap,
                cylinderHalfLengthMm: reservationCellSize[axialAxis] / 2 + tolerance.outerWrap,
                localServiceBoxes: localServiceVolumes.map((volume) => volume.box),
              });
              placements = profiled.placements;
              exploredCount += profiled.scannedCount;
            }
            for (const { anchor, offset } of placements) {
              const translatedBlock = translateBox(blockEnvelope, offset);
              const translatedServices = localServiceVolumes.map((volume) => ({
                ...volume,
                box: translateBox(volume.box, offset),
              }));
              const bounds = translateBox(localBounds, offset);
              // For a box every bound is checked at once; for the profiled
              // case each cell already passed the exact cylinder check above.
              if (
                enclosure.kind === "box" &&
                !enclosureContainmentKernel.contains(enclosure, bounds)
              )
                continue;

              const orderedGroups: SeriesGroup[] = routed.map((group, seriesIndex) => ({
                id: group.id,
                seriesIndex,
                grid: group.grid,
                center: group.center.map((value, axis) => value + offset[axis]) as Vec3,
                cellIds: group.cellPositions.map((_, cellIndex) => `${group.id}-c${cellIndex}`),
              }));
              const seriesById = new Map(
                orderedGroups.map((group) => [group.id, group.seriesIndex]),
              );
              const cells = localGroups.flatMap((group) =>
                group.cellPositions.map((position, cellIndex) => ({
                  id: `${group.id}-c${cellIndex}`,
                  groupId: group.id,
                  seriesIndex: seriesById.get(group.id)!,
                  position: position.map((value, axis) => value + offset[axis]) as Vec3,
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
                layerCount: uniqueLayerCount(cells.map((placedCell) => placedCell.position)),
                reservationVolumeMm3,
                utilizationPercent: (reservationVolumeMm3 / enclosureVolume) * 100,
                largestFreeBox:
                  enclosure.kind === "box"
                    ? largestEmptyAxisAlignedBox(container, obstacles)
                    : metricShell().largestFreeBox,
                manufacturability: Math.max(
                  0,
                  100 -
                    (packingMode === "staggered" ? 25 : 0) -
                    Math.max(0, uniqueLayerCount(allLocalCells) - 1) * 8,
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

export function faceAxis(face: PackFace): Axis {
  return face.endsWith("x") ? "x" : "y";
}
