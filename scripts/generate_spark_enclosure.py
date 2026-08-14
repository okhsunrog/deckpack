"""Generate the browser assets for the user-provided Spark case STL.

The collision source is the carbon 2 mm shell (full-2mm.stl): the outer
surface matches the printable two-part model exactly, but the walls above the
rim belt are thinned to 2 mm, so the interior is deeper and the printable
halves are kept only as reference geometry.

Run with:
  uv run --with trimesh --with rtree --with scipy python scripts/generate_spark_enclosure.py
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import numpy as np
import trimesh


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "assets" / "enclosures" / "spark-case" / "source"
FULL_MODEL = SOURCE_DIR / "full-2mm.stl"
PART_1 = SOURCE_DIR / "part1.stl"
PART_2 = SOURCE_DIR / "part2.stl"
MODEL_OUTPUT = ROOT / "public" / "models" / "enclosures" / "spark-case.stl"
MAP_OUTPUT = ROOT / "src" / "data" / "enclosures" / "spark-case-heightmap.json"

GRID_STEP_MM = 0.5
DEPTH_QUANTIZATION_MM = 0.25
RAY_ORIGIN_Z_MM = -1.0
INWARD_NORMAL_Z_LIMIT = -0.02
RAY_BATCH_SIZE = 8_192
JOINT_OVERLAP_MM = 5.0


def load_assembly() -> tuple[trimesh.Trimesh, float, float]:
    if FULL_MODEL.exists():
        assembly = trimesh.load_mesh(FULL_MODEL, process=True)
        # The carbon shell is closed but carries a few non-manifold seam
        # edges, so is_watertight is intentionally not required here.
        if len(assembly.faces) == 0:
            raise RuntimeError("Spark case full model failed to load")
    else:
        part_1 = trimesh.load_mesh(PART_1, process=True)
        part_2 = trimesh.load_mesh(PART_2, process=True)
        if not part_1.is_watertight or not part_2.is_watertight:
            raise RuntimeError("Spark case source meshes must be watertight")

        # The first 5 mm of part 1 form a thin tongue. Part 2 has the matching
        # stepped lip, so the two printable halves overlap instead of meeting
        # edge to edge. In the overlap their two 2 mm skins recreate the floor.
        part_2.apply_translation([0, JOINT_OVERLAP_MM - part_2.bounds[1, 1], 0])
        assembly = trimesh.util.concatenate([part_1, part_2])
    center_mesh_x = float((assembly.bounds[0, 0] + assembly.bounds[1, 0]) / 2)
    center_mesh_y = float((assembly.bounds[0, 1] + assembly.bounds[1, 1]) / 2)
    return assembly, center_mesh_x, center_mesh_y


def export_display_mesh(
    assembly: trimesh.Trimesh,
    center_mesh_x: float,
    center_mesh_y: float,
    enclosure_height: float,
) -> None:
    display = assembly.copy()
    source = display.vertices.copy()
    display.vertices = np.column_stack(
        (
            source[:, 1] - center_mesh_y,
            source[:, 0] - center_mesh_x,
            enclosure_height / 2 - source[:, 2],
        )
    )
    MODEL_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    display.export(MODEL_OUTPUT)


def extract_depth_map(
    assembly: trimesh.Trimesh,
    center_mesh_x: float,
    center_mesh_y: float,
) -> dict[str, object]:
    source_length = float(assembly.bounds[1, 1] - assembly.bounds[0, 1])
    source_width = float(assembly.bounds[1, 0] - assembly.bounds[0, 0])
    columns = int(np.ceil(source_length / GRID_STEP_MM)) + 1
    rows = int(np.ceil(source_width / GRID_STEP_MM)) + 1
    sampled_length = (columns - 1) * GRID_STEP_MM
    sampled_width = (rows - 1) * GRID_STEP_MM
    origin_x = -sampled_length / 2
    origin_y = -sampled_width / 2

    app_x = origin_x + np.arange(columns) * GRID_STEP_MM
    app_y = origin_y + np.arange(rows) * GRID_STEP_MM
    grid_x, grid_y = np.meshgrid(app_x, app_y)
    # App coordinates use X along the deck and Y across it. The source STL uses
    # those axes in the opposite order and stores depth as positive Z.
    source_x = grid_y.ravel() + center_mesh_x
    source_y = grid_x.ravel() + center_mesh_y
    quantized = np.zeros(source_x.shape[0], dtype=np.uint8)

    directions = np.tile([0.0, 0.0, 1.0], (RAY_BATCH_SIZE, 1))
    for start in range(0, source_x.shape[0], RAY_BATCH_SIZE):
        end = min(start + RAY_BATCH_SIZE, source_x.shape[0])
        count = end - start
        origins = np.column_stack(
            (
                source_x[start:end],
                source_y[start:end],
                np.full(count, RAY_ORIGIN_Z_MM),
            )
        )
        locations, ray_indices, face_indices = assembly.ray.intersects_location(
            origins,
            directions[:count],
            multiple_hits=True,
        )
        if len(locations) == 0:
            continue

        inward = assembly.face_normals[face_indices, 2] < INWARD_NORMAL_Z_LIMIT
        locations = locations[inward]
        ray_indices = ray_indices[inward]
        if len(locations) == 0:
            continue

        depths = np.full(count, np.inf)
        np.minimum.at(depths, ray_indices, locations[:, 2])
        valid = np.isfinite(depths) & (depths > DEPTH_QUANTIZATION_MM / 2)
        encoded = np.clip(
            np.rint(depths[valid] / DEPTH_QUANTIZATION_MM),
            1,
            np.iinfo(np.uint8).max,
        ).astype(np.uint8)
        quantized[start:end][valid] = encoded

    decoded_depths = quantized.astype(np.float64) * DEPTH_QUANTIZATION_MM
    usable_volume = float(decoded_depths.sum() * GRID_STEP_MM * GRID_STEP_MM)
    valid_depths = decoded_depths[quantized > 0]
    return {
        "originMm": [origin_x, origin_y],
        "stepMm": GRID_STEP_MM,
        "columns": columns,
        "rows": rows,
        "depthQuantizationMm": DEPTH_QUANTIZATION_MM,
        "safetyMarginMm": GRID_STEP_MM,
        "minDepthMm": float(valid_depths.min()),
        "maxDepthMm": float(valid_depths.max()),
        "usableVolumeMm3": usable_volume,
        "dataBase64": base64.b64encode(quantized.tobytes()).decode("ascii"),
    }


def main() -> None:
    assembly, center_mesh_x, center_mesh_y = load_assembly()
    enclosure_height = float(assembly.bounds[1, 2] - assembly.bounds[0, 2])
    source_length = float(assembly.bounds[1, 1] - assembly.bounds[0, 1])
    source_width = float(assembly.bounds[1, 0] - assembly.bounds[0, 0])
    export_display_mesh(assembly, center_mesh_x, center_mesh_y, enclosure_height)
    depth_map = extract_depth_map(assembly, center_mesh_x, center_mesh_y)
    payload = {
        "id": "spark-case",
        "label": "Spark case (carbon 2 mm)",
        "kind": "mesh-heightmap",
        "dimensionsMm": {
            "length": source_length,
            "width": source_width,
            "height": enclosure_height,
        },
        "modelUrl": "/models/enclosures/spark-case.stl",
        "meshTriangles": int(len(assembly.faces)),
        "depthMap": depth_map,
    }
    MAP_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    MAP_OUTPUT.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(
        f"Generated {MODEL_OUTPUT.relative_to(ROOT)} and {MAP_OUTPUT.relative_to(ROOT)} "
        f"({depth_map['columns']}x{depth_map['rows']}, "
        f"{depth_map['usableVolumeMm3'] / 1_000_000:.3f} l usable)"
    )


if __name__ == "__main__":
    main()
