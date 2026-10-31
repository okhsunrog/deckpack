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

Regenerate the bundled assets from the repository root:

```sh
cargo run -p deckpack-cli --release -- enclosure import \
  assets/enclosures/spark-case/source/full-2mm-flat.stl \
  -o spark.json --display public/models/enclosures/spark-case.stl \
  --id spark-case --label "Spark case (carbon 2 mm)"
```

Set `modelUrl` in `spark.json` to `/models/enclosures/spark-case.stl`, remove `modelPath`,
and save it as `src/data/enclosures/spark-case-heightmap.json`. The importer normalizes
the opening to zero depth, produces the centered display mesh, and samples the 0.5 mm
inner-depth map. The depth map uses only inward-facing triangle intersections so the
outer shell is not mistaken for usable volume. The source opening is at Z = 0.000025 mm;
normalizing that offset changes seven quantized rim samples compared with the old import.

`scripts/generate_spark_enclosure.py` is the retired Python pipeline, retained for provenance.
