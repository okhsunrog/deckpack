import { availableDepthForBox } from "./geometry";
import type { Box3D, CellSpec, EnclosureSpec, PackPlan, ToleranceLayer, Vec3 } from "./types";

/**
 * Analytic cell-holder generator: builds printable wave combs from the exact
 * cell positions of a plan. For every axial row of a horizontal pack it emits
 * a bottom cradle (flat base, wave top) and one interlayer spacer per layer
 * pair (wave on both sides). Pieces are laid out flat for the printer: the
 * wave profile lies in the XY plane and the cell-axis direction becomes Z, so
 * every wall prints vertically without supports.
 */
export interface HolderOptions {
  /** Extra radius on top of the reserved cell radius so cells drop in. */
  clearanceMm: number;
  /** Cylinder length left uncovered at each cell end for nickel strips. */
  terminalMarginMm: number;
  /** Gap between laid-out pieces on the plate. */
  layoutGapMm: number;
  /** Profile sampling step along the lateral axis. */
  sampleStepMm: number;
}

export const DEFAULT_HOLDER_OPTIONS: HolderOptions = {
  clearanceMm: 0.25,
  terminalMarginMm: 7,
  layoutGapMm: 8,
  sampleStepMm: 0.25,
};

export interface ProfilePiece {
  label: string;
  /** Sampled lateral coordinates. */
  t: number[];
  top: number[];
  bottom: number[];
  /** Extrusion length along the cell axis. */
  lengthMm: number;
  /** Axial center of the cell row this piece belongs to. */
  axialCenterMm: number;
}

export interface HolderPieces {
  pieces: ProfilePiece[];
  axialIndex: 0 | 1;
  lateralIndex: 0 | 1;
}

function sumTolerance(stack: ToleranceLayer[], application: ToleranceLayer["application"]): number {
  return stack
    .filter((layer) => layer.application === application)
    .reduce((sum, layer) => sum + Math.max(0, layer.thicknessMm), 0);
}

function groupBy(values: number[], epsilon: number): number[] {
  const centers: number[] = [];
  for (const value of [...values].sort((a, b) => a - b)) {
    const last = centers[centers.length - 1];
    if (last === undefined || Math.abs(value - last) > epsilon) centers.push(value);
  }
  return centers;
}

function waveProfile(
  slabBottom: number,
  slabTop: number,
  bottomDiscs: Array<{ center: number; z: number }>,
  topDiscs: Array<{ center: number; z: number }>,
  bore: number,
  tMin: number,
  tMax: number,
  step: number,
): { t: number[]; top: number[]; bottom: number[] } {
  const t: number[] = [];
  const top: number[] = [];
  const bottom: number[] = [];
  for (let x = tMin; x <= tMax + 1e-9; x += step) {
    let hi = slabTop;
    for (const disc of topDiscs) {
      const dt = x - disc.center;
      if (Math.abs(dt) < bore) hi = Math.min(hi, disc.z - Math.sqrt(bore * bore - dt * dt));
    }
    let lo = slabBottom;
    for (const disc of bottomDiscs) {
      const dt = x - disc.center;
      if (Math.abs(dt) < bore) lo = Math.max(lo, disc.z + Math.sqrt(bore * bore - dt * dt));
    }
    t.push(x);
    top.push(hi);
    bottom.push(Math.min(lo, hi));
  }
  return { t, top, bottom };
}

export interface HolderBuild {
  pieces: Array<{ label: string; triangleCount: number; sizeMm: Vec3; minWallMm: number }>;
  stl: ArrayBuffer;
}

export function computeHolderPieces(
  plan: PackPlan,
  cell: CellSpec,
  toleranceStack: ToleranceLayer[],
  enclosure: EnclosureSpec,
  options: HolderOptions = DEFAULT_HOLDER_OPTIONS,
): HolderPieces {
  if (plan.orientation === "z") {
    throw new Error("Holder generation supports horizontal cells only");
  }
  const axialIndex = plan.orientation === "x" ? 0 : 1;
  const lateralIndex = axialIndex === 0 ? 1 : 0;
  const radial = sumTolerance(toleranceStack, "radial");
  const bore = cell.sleevedDiameterMm / 2 + radial + options.clearanceMm;
  const stripLength = cell.sleevedHeightMm - 2 * options.terminalMarginMm;

  const rowCenters = groupBy(
    plan.cells.map((placed) => placed.position[axialIndex]),
    cell.sleevedHeightMm / 2,
  );
  const pieces: ProfilePiece[] = [];

  for (const [rowIndex, rowCenter] of rowCenters.entries()) {
    const rowCells = plan.cells.filter(
      (placed) => Math.abs(placed.position[axialIndex] - rowCenter) < cell.sleevedHeightMm / 2,
    );
    const layerZs = groupBy(
      rowCells.map((placed) => placed.position[2]),
      1,
    );
    const layers = layerZs.map((z) =>
      rowCells
        .filter((placed) => Math.abs(placed.position[2] - z) <= 1)
        .map((placed) => ({ center: placed.position[lateralIndex], z: placed.position[2] })),
    );
    const lateralAll = rowCells.map((placed) => placed.position[lateralIndex]);
    const tMin = Math.min(...lateralAll) - bore - 1.2;
    const tMax = Math.max(...lateralAll) + bore + 1.2;

    // Bottom cradle: the underside follows the enclosure floor under the
    // strip, so the piece sits flush on ramps and clears the seam ridge while
    // filling any gap down to the deep floor.
    const bottomLayer = layers[0];
    const cradle = waveProfile(
      -enclosure.dimensionsMm.height / 2,
      Math.min(...bottomLayer.map((d) => d.z)),
      [],
      bottomLayer,
      bore,
      tMin,
      tMax,
      options.sampleStepMm,
    );
    const topZ = enclosure.dimensionsMm.height / 2;
    const axialLo = rowCenter - stripLength / 2;
    const axialHi = rowCenter + stripLength / 2;
    for (let i = 0; i < cradle.t.length; i += 1) {
      const t = cradle.t[i];
      const probe: Box3D =
        axialIndex === 0
          ? { min: [axialLo, t - 0.25, 0], max: [axialHi, t + 0.25, 0] }
          : { min: [t - 0.25, axialLo, 0], max: [t + 0.25, axialHi, 0] };
      const floorZ = topZ - availableDepthForBox(enclosure, probe);
      cradle.bottom[i] = Math.min(Math.max(cradle.bottom[i], floorZ), cradle.top[i]);
    }
    // Trim the ends where the rising case wall leaves no room for material.
    let first = 0;
    let last = cradle.t.length - 1;
    while (first < last && cradle.top[first] - cradle.bottom[first] < 0.05) first += 1;
    while (last > first && cradle.top[last] - cradle.bottom[last] < 0.05) last -= 1;
    pieces.push({
      label: `cradle-row${rowIndex + 1}`,
      t: cradle.t.slice(first, last + 1),
      top: cradle.top.slice(first, last + 1),
      bottom: cradle.bottom.slice(first, last + 1),
      lengthMm: stripLength,
      axialCenterMm: rowCenter,
    });

    // Interlayer spacers between each pair of adjacent layers.
    for (let index = 0; index + 1 < layers.length; index += 1) {
      const lower = layers[index];
      const upper = layers[index + 1];
      pieces.push({
        label: `spacer-row${rowIndex + 1}-L${index + 1}${index + 2}`,
        ...waveProfile(
          Math.min(...lower.map((d) => d.z)),
          Math.max(...upper.map((d) => d.z)),
          lower,
          upper,
          bore,
          tMin,
          tMax,
          options.sampleStepMm,
        ),
        lengthMm: stripLength,
        axialCenterMm: rowCenter,
      });
    }
  }

  return { pieces, axialIndex, lateralIndex };
}

export function generateHolder(
  plan: PackPlan,
  cell: CellSpec,
  toleranceStack: ToleranceLayer[],
  enclosure: EnclosureSpec,
  options: HolderOptions = DEFAULT_HOLDER_OPTIONS,
): HolderBuild {
  return buildStl(
    computeHolderPieces(plan, cell, toleranceStack, enclosure, options).pieces,
    options,
  );
}

/**
 * Triangles of a piece in its assembled position inside the enclosure, as a
 * flat position array for a three.js BufferGeometry.
 */
export function assembledPieceTriangles(piece: ProfilePiece, layout: HolderPieces): number[] {
  const positions: number[] = [];
  const axialStart = piece.axialCenterMm - piece.lengthMm / 2;
  const map = (t: number, z: number, s: number): Vec3 => {
    const point: Vec3 = [0, 0, 0];
    point[layout.lateralIndex] = t;
    point[layout.axialIndex] = axialStart + s;
    point[2] = z;
    return point;
  };
  emitPieceTriangles(piece, map, (a, b, c) => positions.push(...a, ...b, ...c));
  return positions;
}

/** Shared prism topology: caps, wave surfaces, and end walls of one piece. */
function emitPieceTriangles(
  piece: ProfilePiece,
  map: (t: number, z: number, s: number) => Vec3,
  emit: (a: Vec3, b: Vec3, c: Vec3) => void,
): void {
  const n = piece.t.length;
  const L = piece.lengthMm;
  for (let i = 0; i + 1 < n; i += 1) {
    const b0 = map(piece.t[i], piece.bottom[i], 0);
    const b1 = map(piece.t[i + 1], piece.bottom[i + 1], 0);
    const u0 = map(piece.t[i], piece.top[i], 0);
    const u1 = map(piece.t[i + 1], piece.top[i + 1], 0);
    const B0 = map(piece.t[i], piece.bottom[i], L);
    const B1 = map(piece.t[i + 1], piece.bottom[i + 1], L);
    const U0 = map(piece.t[i], piece.top[i], L);
    const U1 = map(piece.t[i + 1], piece.top[i + 1], L);
    // front cap and back cap
    emit(b0, u0, b1);
    emit(b1, u0, u1);
    emit(B0, B1, U0);
    emit(B1, U1, U0);
    // top wave and bottom surfaces
    emit(u0, U0, u1);
    emit(u1, U0, U1);
    emit(b0, b1, B0);
    emit(b1, B1, B0);
  }
  const last = n - 1;
  emit(
    map(piece.t[0], piece.bottom[0], 0),
    map(piece.t[0], piece.bottom[0], L),
    map(piece.t[0], piece.top[0], 0),
  );
  emit(
    map(piece.t[0], piece.top[0], 0),
    map(piece.t[0], piece.bottom[0], L),
    map(piece.t[0], piece.top[0], L),
  );
  emit(
    map(piece.t[last], piece.bottom[last], 0),
    map(piece.t[last], piece.top[last], 0),
    map(piece.t[last], piece.bottom[last], L),
  );
  emit(
    map(piece.t[last], piece.top[last], 0),
    map(piece.t[last], piece.top[last], L),
    map(piece.t[last], piece.bottom[last], L),
  );
}

function buildStl(pieces: ProfilePiece[], options: HolderOptions): HolderBuild {
  interface Tri {
    normal: Vec3;
    a: Vec3;
    b: Vec3;
    c: Vec3;
  }
  const triangles: Tri[] = [];
  const summaries: HolderBuild["pieces"] = [];
  let offsetX = 0;

  const push = (a: Vec3, b: Vec3, c: Vec3) => {
    const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n: Vec3 = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    const len = Math.hypot(...n) || 1;
    triangles.push({ normal: [n[0] / len, n[1] / len, n[2] / len], a, b, c });
  };

  for (const piece of pieces) {
    const before = triangles.length;
    const t0 = piece.t[0];
    const zBase = Math.min(...piece.bottom);
    const startX = offsetX;
    const last = piece.t.length - 1;
    let minWall = Infinity;
    for (let i = 0; i <= last; i += 1) {
      minWall = Math.min(minWall, piece.top[i] - piece.bottom[i]);
    }
    // Print layout: profile flat in XY, cell axis becomes the vertical Z.
    emitPieceTriangles(piece, (t, z, s) => [startX + t - t0, z - zBase, s], push);

    summaries.push({
      label: piece.label,
      triangleCount: triangles.length - before,
      sizeMm: [piece.t[last] - t0, Math.max(...piece.top) - zBase, piece.lengthMm],
      minWallMm: minWall,
    });
    offsetX += piece.t[last] - t0 + options.layoutGapMm;
  }

  const buffer = new ArrayBuffer(84 + triangles.length * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triangles.length, true);
  let cursor = 84;
  for (const tri of triangles) {
    for (const vec of [tri.normal, tri.a, tri.b, tri.c]) {
      view.setFloat32(cursor, vec[0], true);
      view.setFloat32(cursor + 4, vec[1], true);
      view.setFloat32(cursor + 8, vec[2], true);
      cursor += 12;
    }
    cursor += 2;
  }
  return { pieces: summaries, stl: buffer };
}
