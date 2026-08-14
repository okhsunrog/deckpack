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
- Balance-harness and power-output regions are explicit collision keep-outs.
- `brick` and `staggered` lattices are both enumerated. Staggered results are marked as requiring a custom holder.
- `PackPlan.blocks` and global `seriesOrder` allow a future pack to be split into multiple physical blocks while retaining one electrical S-chain.
- Enclosure checks go through `ContainmentKernel`; v1 provides a box implementation.
- Component visuals can use an STL, a top texture, or a procedural case without changing the collision geometry.

Libraries live in [`src/data/cells.json`](src/data/cells.json) and [`src/data/components.json`](src/data/components.json). Each sourced record carries the checked URL, date, and a note describing whether dimensions refer to a finished cell, PCB, or enclosure.

Third-party visual assets and their licenses are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
