import type { HolderPieces, ProfilePiece } from "../bindings";

type Vec3 = [number, number, number];

/**
 * Triangles of a piece in its assembled position inside the enclosure, as a
 * flat position array for a three.js BufferGeometry. The profiles come from
 * the Rust core; only this display extrusion lives on the frontend.
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
