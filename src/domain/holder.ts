import type { CellSpec, PackPlan, ToleranceLayer, Vec3 } from "./types";

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

interface ProfilePiece {
  label: string;
  /** Sampled lateral coordinates. */
  t: number[];
  top: number[];
  bottom: number[];
  /** Extrusion length along the cell axis. */
  lengthMm: number;
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

export function generateHolder(
  plan: PackPlan,
  cell: CellSpec,
  toleranceStack: ToleranceLayer[],
  options: HolderOptions = DEFAULT_HOLDER_OPTIONS,
): HolderBuild {
  if (plan.orientation === "z") {
    throw new Error("Holder generation supports horizontal cells only");
  }
  const axialIndex = plan.orientation === "x" ? 0 : 1;
  const lateralIndex = axialIndex === 0 ? 1 : 0;
  const radial = sumTolerance(toleranceStack, "radial");
  const base = Math.max(0.8, sumTolerance(toleranceStack, "all-faces"));
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

    // Bottom cradle: flat base under the lowest layer.
    const bottomLayer = layers[0];
    const cradleBottom = Math.min(...bottomLayer.map((d) => d.z)) - bore - base;
    pieces.push({
      label: `cradle-row${rowIndex + 1}`,
      ...waveProfile(
        cradleBottom,
        Math.min(...bottomLayer.map((d) => d.z)),
        [],
        bottomLayer,
        bore,
        tMin,
        tMax,
        options.sampleStepMm,
      ),
      lengthMm: stripLength,
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
      });
    }
  }

  return buildStl(pieces, options);
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
    const X = (i: number) => offsetX + piece.t[i] - t0;
    const yTop = (i: number) => piece.top[i] - zBase;
    const yBot = (i: number) => piece.bottom[i] - zBase;
    const L = piece.lengthMm;
    const n = piece.t.length;
    let minWall = Infinity;
    for (let i = 0; i < n; i += 1) minWall = Math.min(minWall, piece.top[i] - piece.bottom[i]);

    for (let i = 0; i + 1 < n; i += 1) {
      const b0: Vec3 = [X(i), yBot(i), 0];
      const b1: Vec3 = [X(i + 1), yBot(i + 1), 0];
      const u0: Vec3 = [X(i), yTop(i), 0];
      const u1: Vec3 = [X(i + 1), yTop(i + 1), 0];
      const B0: Vec3 = [X(i), yBot(i), L];
      const B1: Vec3 = [X(i + 1), yBot(i + 1), L];
      const U0: Vec3 = [X(i), yTop(i), L];
      const U1: Vec3 = [X(i + 1), yTop(i + 1), L];
      // front cap (z=0, normal -z) and back cap (z=L, normal +z)
      push(b0, u0, b1);
      push(b1, u0, u1);
      push(B0, B1, U0);
      push(B1, U1, U0);
      // top wave and bottom surfaces
      push(u0, U0, u1);
      push(u1, U0, U1);
      push(b0, b1, B0);
      push(b1, B1, B0);
    }
    // end walls at tMin/tMax
    const last = n - 1;
    push([X(0), yBot(0), 0], [X(0), yBot(0), L], [X(0), yTop(0), 0]);
    push([X(0), yTop(0), 0], [X(0), yBot(0), L], [X(0), yTop(0), L]);
    push([X(last), yBot(last), 0], [X(last), yTop(last), 0], [X(last), yBot(last), L]);
    push([X(last), yTop(last), 0], [X(last), yTop(last), L], [X(last), yBot(last), L]);

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
