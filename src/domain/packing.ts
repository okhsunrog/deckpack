import {
  boxContainmentKernel,
  boxFromCenterSize,
  boxSize,
  boxVolume,
  distance,
  enclosureBounds,
  expandBox,
  largestEmptyAxisAlignedBox,
  translateBox,
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
  };
}

function createLocalGroups(
  seriesFactors: Vec3,
  template: GroupTemplate,
  betweenGroups: number,
): LocalGroup[] {
  const pitch = template.reservationSize.map((value) => value + betweenGroups) as Vec3;
  const groups: LocalGroup[] = [];
  for (let x = 0; x < seriesFactors[0]; x += 1) {
    for (let y = 0; y < seriesFactors[1]; y += 1) {
      for (let z = 0; z < seriesFactors[2]; z += 1) {
        const grid: Vec3 = [x, y, z];
        const origin: Vec3 = [x * pitch[0], y * pitch[1], z * pitch[2]];
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
  const positive = reservation.face.startsWith("positive");
  center[faceAxis] = positive
    ? envelope.max[faceAxis] + reservation.sizeMm[faceAxis] / 2
    : envelope.min[faceAxis] - reservation.sizeMm[faceAxis] / 2;
  const offset = reservation.offsetMm ?? [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) center[axis] += offset[axis];
  return boxFromCenterSize(center, reservation.sizeMm);
}

function anchorOffset(bounds: Box3D, enclosure: Box3D, anchor: PlacementAnchor): Vec3 {
  const boundsCenterY = (bounds.min[1] + bounds.max[1]) / 2;
  let x = -(bounds.min[0] + bounds.max[0]) / 2;
  if (anchor === "tail") x = enclosure.min[0] - bounds.min[0];
  if (anchor === "nose") x = enclosure.max[0] - bounds.max[0];
  return [x, -boundsCenterY, enclosure.min[2] - bounds.min[2]];
}

function uniqueLayerCount(cells: Vec3[]): number {
  return new Set(cells.map((position) => position[2].toFixed(3))).size;
}

function installedClearance(container: Box3D, object: Box3D): number {
  return Math.min(
    object.min[0] - container.min[0],
    container.max[0] - object.max[0],
    object.min[1] - container.min[1],
    container.max[1] - object.max[1],
    container.max[2] - object.max[2],
  );
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
  return [
    plan.orientation,
    plan.packingMode,
    plan.staggerRowAxis ?? "-",
    plan.parallelFactors.join("x"),
    plan.seriesFactors.join("x"),
    plan.anchor,
    size.join("x"),
  ].join("|");
}

function range(values: number[]): [number, number] {
  return [Math.min(...values), Math.max(...values)];
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
  for (const plan of plans) {
    const center = normalizedInverse(plan.metrics.centerOffsetMm, ...centerRange);
    const chain = normalizedInverse(plan.metrics.seriesChainLengthMm, ...chainRange);
    const clearance = normalized(plan.metrics.minClearanceMm, ...clearanceRange);
    const free = normalized(plan.metrics.largestFreeBox.volumeMm3, ...freeRange);
    const manufacturing = plan.metrics.manufacturability / 100;
    plan.metrics.score = Math.round(
      (center * 0.25 + chain * 0.22 + clearance * 0.2 + free * 0.18 + manufacturing * 0.15) * 100,
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
  const enclosureVolume = boxVolume(container);
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
            exploredCount += ANCHORS.length;
            const localGroups = createLocalGroups(sFactors, template, tolerance.betweenGroups);
            const routed = routeGroups(localGroups, sFactors);
            const allLocalCells = localGroups.flatMap((group) => group.cellPositions);
            if (uniqueLayerCount(allLocalCells) > pack.maxLayers) continue;

            const reservationCellSize = actualCellSize.map((value, axis) =>
              axis === axialAxis ? value + tolerance.axialPerEnd * 2 : value + tolerance.radial * 2,
            ) as Vec3;
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

            for (const anchor of ANCHORS) {
              const offset = anchorOffset(localBounds, container, anchor);
              const translatedBlock = translateBox(blockEnvelope, offset);
              const translatedServices = localServiceVolumes.map((volume) => ({
                ...volume,
                box: translateBox(volume.box, offset),
              }));
              const bounds = translateBox(localBounds, offset);
              if (!boxContainmentKernel.contains(enclosure, bounds)) continue;

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
                minClearanceMm: installedClearance(container, bounds),
                layerCount: uniqueLayerCount(cells.map((placedCell) => placedCell.position)),
                reservationVolumeMm3,
                utilizationPercent: (reservationVolumeMm3 / enclosureVolume) * 100,
                largestFreeBox: largestEmptyAxisAlignedBox(container, obstacles),
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
