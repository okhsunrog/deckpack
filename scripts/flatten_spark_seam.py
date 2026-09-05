"""Remove the seam reinforcement remnant from the Spark case source mesh.

``assets/enclosures/spark-case/source/full-2mm.stl`` was derived from a
printable two-part model and still carries the reinforcement band of the
printable seam: a 2 mm thick pad on the inner surface running across the
floor, up the walls and around the corners at app x in [-27, -15] mm
(source y = app x + centre_y). The physical carbon case is monolithic and
smooth there. This script writes ``full-2mm-flat.stl`` next to the original
with that band removed everywhere; the original file is left untouched.

Coordinate conventions (see ``generate_spark_enclosure.py``): the source STL
has the long side along Y, the width along X and depth growing along +Z with
the opening at low z. The app uses X along the deck (= source Y - centre_y)
and Y across it (= source X - centre_x).

Method
------
The mid-body is (nearly) prismatic, so the monolithic shape inside the band is
the linear blend of the cross-sections taken just outside it (2 mm before and
after the band). Every vertex inside the band is projected onto both
reference sections (nearest point on the section polylines) and the two
projections are blended by the vertex position along the band, which keeps the
slight taper of the case. A vertex is snapped onto that blended target when it
deviates from it by more than a threshold: 0.05 mm where the target lies on the
inner floor (the floor is exactly flat on both sides, so any deviation there is
the ridge) and 0.5 mm elsewhere (the walls carry ~0.3 mm of tessellation and
taper noise that must not be touched, because many wall triangles are long and
reach far outside the band; the ridge itself deviates by ~2 mm). Faces that
collapse to zero area are dropped. Nothing outside the band moves, so the
depth map sampled from the result equals the original's outside the band.

Run from the repository root:

  uv run --with trimesh --with rtree --with scipy --with numpy python scripts/flatten_spark_seam.py

Verification lives in ``crates/deckpack-mesh/tests/spark_case_flat.rs``.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import trimesh

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "assets" / "enclosures" / "spark-case" / "source"
INPUT = SOURCE_DIR / "full-2mm.stl"
OUTPUT = SOURCE_DIR / "full-2mm-flat.stl"

# Band of the seam remnant in app X (source Y minus the mesh centre).
SEAM_BAND_APP_X = (-27.0, -15.0)
# Reference cross-sections are taken this far outside the band.
REFERENCE_MARGIN_MM = 2.0
# Nominal shell thickness: the inner floor sits this far above the outer bottom.
SHELL_THICKNESS_MM = 2.0
# Snap thresholds (deviation from the blended reference profile).
FLOOR_THRESHOLD_MM = 0.05
WALL_THRESHOLD_MM = 0.5


def section_xz(mesh: trimesh.Trimesh, plane_y: float) -> np.ndarray:
    """Cross-section segments in the (x, z) plane at source ``y = plane_y``."""
    segments = trimesh.intersections.mesh_plane(
        mesh, plane_normal=[0.0, 1.0, 0.0], plane_origin=[0.0, plane_y, 0.0]
    )
    if len(segments) == 0:
        raise RuntimeError(f"cross-section at y = {plane_y} is empty")
    return segments[:, :, [0, 2]]


def closest_on_segments(points: np.ndarray, segments: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Nearest point on a set of 2-D segments for each point.

    Returns ``(distance, closest_point)``; ``points`` is (n, 2), ``segments``
    is (m, 2, 2).
    """
    a = segments[:, 0, :]
    ab = segments[:, 1, :] - a
    ab2 = np.maximum((ab * ab).sum(axis=1), 1e-18)
    t = ((points[:, None, :] - a[None, :, :]) * ab[None, :, :]).sum(axis=2) / ab2[None, :]
    t = np.clip(t, 0.0, 1.0)
    projected = a[None, :, :] + t[:, :, None] * ab[None, :, :]
    distance = np.linalg.norm(projected - points[:, None, :], axis=2)
    nearest = distance.argmin(axis=1)
    rows = np.arange(len(points))
    return distance[rows, nearest], projected[rows, nearest]


def flatten_seam_band(mesh: trimesh.Trimesh, center_y: float) -> dict[str, float | int]:
    y0 = SEAM_BAND_APP_X[0] + center_y
    y1 = SEAM_BAND_APP_X[1] + center_y
    ya, yb = y0 - REFERENCE_MARGIN_MM, y1 + REFERENCE_MARGIN_MM
    reference_a = section_xz(mesh, ya)
    reference_b = section_xz(mesh, yb)
    nominal_floor_z = max(reference_a[:, :, 1].max(), reference_b[:, :, 1].max()) - SHELL_THICKNESS_MM
    floor_levels = []
    for name, reference in (("before", reference_a), ("after", reference_b)):
        horizontal = np.abs(reference[:, 0, 1] - reference[:, 1, 1]) < 1e-4
        on_floor = horizontal & (np.abs(reference[:, 0, 1] - nominal_floor_z) < 0.05)
        if not on_floor.any():
            raise RuntimeError(
                f"reference section {name} the band has no floor at z = {nominal_floor_z:.3f}"
            )
        floor_levels.append(reference[on_floor, 0, 1])
    # The modelled floor sits a few micrometres off the nominal 2 mm shell.
    floor_z = float(np.median(np.concatenate(floor_levels)))

    vertices = mesh.vertices.copy()
    selected = np.where((vertices[:, 1] > y0) & (vertices[:, 1] < y1))[0]
    coordinates = vertices[selected][:, [0, 2]]
    _, target_a = closest_on_segments(coordinates, reference_a)
    _, target_b = closest_on_segments(coordinates, reference_b)
    t = ((vertices[selected, 1] - ya) / (yb - ya))[:, None]
    target = target_a * (1.0 - t) + target_b * t
    deviation = np.linalg.norm(coordinates - target, axis=1)
    target_on_floor = np.abs(target[:, 1] - floor_z) < 0.05
    move = np.where(target_on_floor, deviation > FLOOR_THRESHOLD_MM, deviation > WALL_THRESHOLD_MM)

    moved = selected[move]
    vertices[moved, 0] = target[move, 0]
    vertices[moved, 2] = target[move, 1]
    distances = np.linalg.norm(vertices[moved] - mesh.vertices[moved], axis=1)
    mesh.vertices = vertices

    # Faces that collapsed (e.g. the vertical flanks of the pad) carry no geometry.
    areas = mesh.area_faces
    degenerate = areas < 1e-9
    if degenerate.any():
        mesh.update_faces(~degenerate)

    return {
        "floor_z": float(floor_z),
        "selected": int(len(selected)),
        "moved": int(len(moved)),
        "moved_floor": int((target_on_floor & move).sum()),
        "moved_over_1mm": int((distances > 1.0).sum()),
        "max_move": float(distances.max()) if len(distances) else 0.0,
        "dropped_faces": int(degenerate.sum()),
        "remaining_deviation": float(deviation[~move].max()) if (~move).any() else 0.0,
    }


def check_band_floor(mesh: trimesh.Trimesh, center_x: float, center_y: float, floor_z: float) -> None:
    """Rays through the middle of the band must reach the flat floor."""
    app_x = np.arange(SEAM_BAND_APP_X[0] - 1.0, SEAM_BAND_APP_X[1] + 1.01, 0.25)
    app_y = np.arange(-30.0, 30.01, 2.5)
    grid_x, grid_y = np.meshgrid(app_x, app_y)
    origins = np.column_stack(
        (grid_y.ravel() + center_x, grid_x.ravel() + center_y, np.full(grid_x.size, -1.0))
    )
    directions = np.tile([0.0, 0.0, 1.0], (len(origins), 1))
    locations, ray_indices, face_indices = mesh.ray.intersects_location(
        origins, directions, multiple_hits=True
    )
    inward = mesh.face_normals[face_indices, 2] < -0.02
    depth = np.full(len(origins), np.inf)
    np.minimum.at(depth, ray_indices[inward], locations[inward, 2])
    error = np.abs(depth - floor_z).max()
    if not np.isfinite(error) or error > 0.01:
        raise RuntimeError(f"band floor is not flat: max |depth - {floor_z:.3f}| = {error:.4f} mm")
    print(f"self-check: {len(origins)} rays across the band all read the floor at {floor_z:.3f} mm")


def main() -> None:
    mesh = trimesh.load_mesh(INPUT, process=True)
    if len(mesh.faces) == 0:
        raise RuntimeError(f"{INPUT} failed to load")
    original_faces = len(mesh.faces)
    center_x = float((mesh.bounds[0, 0] + mesh.bounds[1, 0]) / 2)
    center_y = float((mesh.bounds[0, 1] + mesh.bounds[1, 1]) / 2)
    bounds_before = mesh.bounds.copy()

    stats = flatten_seam_band(mesh, center_y)
    if not np.allclose(mesh.bounds, bounds_before):
        raise RuntimeError("flattening changed the mesh bounds")
    check_band_floor(mesh, center_x, center_y, stats["floor_z"])

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    mesh.export(OUTPUT, file_type="stl")
    print(
        f"wrote {OUTPUT.relative_to(ROOT)}: {len(mesh.vertices)} vertices, {len(mesh.faces)} faces "
        f"({original_faces} before, {stats['dropped_faces']} degenerate dropped)"
    )
    print(
        f"band vertices: {stats['selected']} inside, {stats['moved']} snapped "
        f"({stats['moved_floor']} onto the floor, {stats['moved_over_1mm']} moved by more than 1 mm, "
        f"max move {stats['max_move']:.3f} mm); largest deviation left in place "
        f"{stats['remaining_deviation']:.3f} mm"
    )


if __name__ == "__main__":
    main()
