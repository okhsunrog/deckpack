# Deckpack

Desktop-first 3D planner for electric-longboard enclosure internals. It exhaustively enumerates geometric layouts for an `nSmP` cylindrical-cell pack, ranks feasible variants, and lets the user place ESC, BMS, antispark, and custom blocks inside the enclosure.

The app is a static frontend. Project inputs and placed components stay in `localStorage` and can be exported as JSON.

## Development

```bash
vp install
vp dev
```

Validation:

```bash
vp check
vp test
vp build
```

## Geometry model

- All calculations use millimetres and grams.
- Cell-library dimensions are maximum finished-cell dimensions including the manufacturer sleeve.
- Nickel, fishpaper, compound, group separators, and outer wrap remain separate tolerance layers.
- Power and balance wiring share one collision keep-out by default; advanced mode can split them.
- `brick` and `staggered` lattices are both enumerated. Staggered results are marked as requiring a custom holder; degenerate staggered variants that coincide with the brick grid are skipped. Staggered rows nest both inside a parallel group and across single-cell-thick series groups (row pitch ≈ pitch·√3/2, alternate rows shifted half a pitch).
- `PackPlan.blocks` and global `seriesOrder` allow a future pack to be split into multiple physical blocks while retaining one electrical S-chain.
- Enclosure checks go through `ContainmentKernel`. Two implementations exist: a plain box and a mesh height map built from an STL (`mesh-heightmap`), sampled on a 0.5 mm grid with 0.25 mm depth quantization.
- Inside a profiled enclosure every cell is validated as a cylinder against the height field: the pack settles onto the inner surface like a rigid body, and a horizontal cell may overhang a ramp when its curved underside (sqrt(r²−d²)) genuinely clears it, while real intersections are rejected.
- The bundled Spark case assets are generated from two printable STL halves by `scripts/generate_spark_enclosure.py` (run with `uv run --with trimesh --with rtree --with scipy python scripts/generate_spark_enclosure.py`).
- Component visuals can use an STL, a top texture, or a procedural case without changing the collision geometry.

Libraries live in [`src/data/cells.json`](src/data/cells.json) and [`src/data/components.json`](src/data/components.json). Each sourced record carries the checked URL, date, and a note describing whether dimensions refer to a finished cell, PCB, or enclosure.

Third-party visual assets and their licenses are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
