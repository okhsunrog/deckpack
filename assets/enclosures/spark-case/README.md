# Spark case source geometry

The two STL files in `source/` were provided by the enclosure seller for this project.

They form one enclosure with a 5 mm lap joint:

- `part1.stl`: deep section, with the lower tongue at its minimum-Y edge;
- `part2.stl`: shallow Spark/connector section, with the matching lip at its maximum-Y edge.

`full-2mm.stl` is the carbon 2 mm shell derived from those halves. It still carries a
remnant of the printable seam reinforcement: a 2 mm pad on the inner surface running
across the floor, up the walls and around the corners at app x ∈ [-27, -15] mm. The
physical carbon case is monolithic and smooth there.

`full-2mm-flat.stl` is the same shell with that band removed (binary STL, same units
and orientation, 64 010 triangles). It was produced by

```sh
uv run --with trimesh --with rtree --with scipy --with numpy python scripts/flatten_spark_seam.py
```

which snaps the band vertices onto the blend of the two cross-sections taken just
outside the band and drops the faces that collapse; nothing outside the band moves.
`crates/deckpack-mesh/tests/spark_case_flat.rs` checks the result against the bundled
height map and against an import of the untouched `full-2mm.stl`.

Run the generator from the repository root:

```sh
uv run --with trimesh --with rtree --with scipy python scripts/generate_spark_enclosure.py
```

It produces the centered display mesh in `public/models/enclosures/` and the 0.5 mm
inner-depth map used by the containment kernel. The depth map uses only inward-facing
triangle intersections so the outer shell is not mistaken for usable volume.
