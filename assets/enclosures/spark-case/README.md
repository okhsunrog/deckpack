# Spark case source geometry

The two STL files in `source/` were provided by the enclosure seller for this project.

They form one enclosure with a 5 mm lap joint:

- `part1.stl`: deep section, with the lower tongue at its minimum-Y edge;
- `part2.stl`: shallow Spark/connector section, with the matching lip at its maximum-Y edge.

Run the generator from the repository root:

```sh
uv run --with trimesh --with rtree --with scipy python scripts/generate_spark_enclosure.py
```

It produces the centered display mesh in `public/models/enclosures/` and the 0.5 mm
inner-depth map used by the containment kernel. The depth map uses only inward-facing
triangle intersections so the outer shell is not mistaken for usable volume.
