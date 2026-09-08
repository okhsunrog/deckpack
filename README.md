# Deckpack

Desktop-first 3D planner for electric-longboard enclosure internals. It exhaustively enumerates geometric layouts for an `nSmP` cylindrical-cell pack, ranks feasible variants, and lets the user place ESC, BMS, antispark, and custom blocks inside the enclosure.

The app is a static frontend wrapped in a [Tauri 2](https://tauri.app) desktop shell. Project inputs and placed components stay in `localStorage` and can be exported as JSON; in the desktop build exports go through the native "Save as" dialog.

## Development

Browser-only workflow:

```bash
vp install
vp dev
```

Desktop app (needs a Rust toolchain and the [Tauri system prerequisites](https://tauri.app/start/prerequisites/)):

```bash
vp run tauri dev     # dev server + native window with hot reload
vp run tauri build   # release binary and installers in src-tauri/target/release/bundle
```

Validation:

```bash
vp check
vp test
vp build
cargo fmt --check && cargo clippy --workspace && cargo test --workspace
```

### Command line

```bash
cargo install --path crates/deckpack-cli        # or: cargo run -p deckpack-cli --release -- …
deckpack plan                                    # default project: 12S3P EVE 50PL in the Spark case
deckpack plan --box 800x210x60 -p 4 --mode brick --limit 10
deckpack plan --project my-project.json --json   # project JSON exported by the app
deckpack evaluate --project my-project.json --plan 1
deckpack holder --project my-project.json --plan 1 --style edge -o holder.stl --pieces-dir holder/ --bed 220x220
deckpack cells --plan 1 -o cells.stl             # the cells as cylinders, for CAD
deckpack enclosure import case.stl -o case.json --display case-app.stl
deckpack plan --enclosure-file case.json
deckpack library cells
```

`--plan` accepts a 1-based rank or a plan id; `--json` prints the same structures the desktop app exchanges with its core.

`holder` writes all pieces laid out in one STL and, with `--pieces-dir`, one STL per piece for the slicer. `--csg` builds each piece with CSG; `--rails` adds 8 mm end rails with 3.2 mm screw holes running along the pack height, positioned identically on every piece, and `--cap` adds a cap over the top layer so the sandwich can be bolted. For the least plastic use the edge style with `--band 8 --no-spacers --web 1.2 --cusp-height 0.6`: `--no-spacers` zeroes the `between-rows` tolerance layers before planning, so the upper cells nest in the lower ones and the cradle bands alone locate the pack (about 3× less material and print time than the defaults); `--bed WxD` reports whether each piece fits the print bed straight or rotated 45° and how many strips share a plate. Cusps between bores are flattened to `minWallMm` (0.8 mm by default) so the slicer does not drop them, and the cradle base under the cells is the «Дно холдера» tolerance layer: leave it at 0 for packs without a printed holder, raise it to 0.4–1.2 mm (as far as the lid allows) when the comb must stay in one piece.

### MCP server

`deckpack-mcp` speaks MCP over stdio and offers `default_config`, `list_cells`, `list_components`, `list_enclosures`, `plan_pack`, `get_plan`, `evaluate_layout`, `suggest_placement`, `auto_place`, `generate_holder` and `import_enclosure`. Tool arguments and results use the same camelCase JSON as the app. Register it with, for example:

```bash
cargo build --release -p deckpack-mcp
claude mcp add --scope user deckpack -- "$PWD/target/release/deckpack-mcp"
```

`RUST_LOG=debug` sends tracing output to stderr without disturbing the protocol on stdout.

### Rust workspace

All domain logic lives in a Cargo workspace; the React frontend renders and edits state only.

- `crates/deckpack-core`: data model, geometry and height-map queries, pack enumeration (rayon-parallel), holder generation. Pure computation, no Tauri.
- `crates/deckpack-mesh`: STL parsing, the STL → height-map sampler used to import enclosures at runtime, cell/holder mesh export, and the CSG holder build on [`manifold-rust`](https://github.com/larsbrubaker/manifold-rust) (rails with screw holes, guaranteed-manifold output). `import_enclosure` stores each import under `<app data>/enclosures/<id>.{json,stl}` and registers it with the core; the display mesh is served to the webview through the asset protocol.
- `src-tauri`: the desktop shell; its commands are thin wrappers over the core crate.
- `crates/deckpack-cli`: the `deckpack` command-line tool (plan, evaluate, holder, enclosure import/info, library) over the same core.
- `crates/deckpack-mcp`: `deckpack-mcp`, an MCP server over stdio that exposes the planner to AI agents.
- `src/`: React UI, three.js scene, zustand store. The only geometry left in TypeScript is a provisional component box drawn before the first evaluation arrives; the holder preview is the CSG solid itself, streamed as raw `f32` triangles by the `holder_mesh` command (registered outside tauri-specta because its response is not JSON).

TypeScript bindings for the commands and types live in `src/bindings.ts` and are generated by `tauri-specta`: `cargo test -p deckpack` (or a debug run) rewrites the file, so never edit it by hand.

`fixtures/domain` holds golden fixtures recorded from the original TypeScript implementation before it was removed (commit `b269644`, script `scripts/dump-fixtures.ts` at that revision). The Rust tests replay them and must keep matching: enumeration results and plan ids exactly, STL output byte for byte. `fixtures/domain/assets` snapshots the enclosure assets those fixtures were recorded against, so the bundled assets can be regenerated without invalidating them.

### AI-assisted debugging (MCP)

Debug builds register [`tauri-plugin-mcp-bridge`](https://github.com/hypothesi/mcp-server-tauri), which opens a local WebSocket on `127.0.0.1:9223` so an MCP client can inspect and drive the running app (DOM, screenshots, console, IPC). Release builds do not include it. Point your assistant at the server with:

```bash
claude mcp add --scope user tauri -- npx -y @hypothesi/tauri-mcp-server
```

Then run `vp run tauri dev` and use the `tauri` MCP tools. The bridge needs `app.withGlobalTauri` in `tauri.conf.json`, which is why it is enabled.

The Rust crates track the unreleased tauri `dev` branch through `[patch.crates-io]` in `src-tauri/Cargo.toml`: it pulls tao 0.37 / wry 0.56 with the Wayland server-side-decoration fixes. Run `cargo update --manifest-path src-tauri/Cargo.toml` to move to a newer `dev` commit.

## Geometry model

- All calculations use millimetres and grams.
- Cell-library dimensions are maximum finished-cell dimensions including the manufacturer sleeve.
- Nickel, fishpaper, compound, group separators, and outer wrap remain separate tolerance layers. Each layer's `application` says where it sits: `between-cells` between every pair of touching cells (compound), `between-columns` only between neighbours of one row or brick grid (the cradle wall of a printed holder), `between-rows` only between the nested cells of adjacent staggered rows (the web of an interlayer spacer), `between-layers` as an extra vertical lift of every staggered row, `floor` under the whole pack.
- Power and balance wiring share one collision keep-out by default; advanced mode can split them.
- `brick` and `staggered` lattices are both enumerated. Staggered results are marked as requiring a custom holder; degenerate staggered variants that coincide with the brick grid are skipped. Staggered rows nest both inside a parallel group and across single-cell-thick series groups: alternate rows are shifted half a lateral pitch and the row pitch is set by the nesting contact distance (cell + fishpaper + compound + spacer wall), so with the spacer wall at 0 the upper row drops into the valleys of the lower one and only the lateral pitch keeps the holder wall. With equal gaps this is the classic pitch·√3/2. When nothing sits between the nested rows (spacer wall and layer lift both 0) the upper cells are loose: after the lattice is draped over the floor each of them rolls along whatever it rests on (lower cells, the floor profile, the walls, each other) until it reaches a real valley or the corner between the last cell and the floor, so an end cell with a single support ends up beside the row instead of hanging above it. With a spacer wall or lift the rows are held and stay on the lattice.
- `PackPlan.blocks` and global `seriesOrder` allow a future pack to be split into multiple physical blocks while retaining one electrical S-chain.
- Enclosure checks go through `ContainmentKernel`. Two implementations exist: a plain box and a mesh height map built from an STL (`mesh-heightmap`), sampled on a 0.5 mm grid with 0.25 mm depth quantization.
- Inside a profiled enclosure every cell is validated as a cylinder against the height field: the pack settles onto the inner surface like a rigid body, and a horizontal cell may overhang a ramp when its curved underside (sqrt(r²−d²)) genuinely clears it, while real intersections are rejected.
- The bundled Spark case assets are produced by `deckpack enclosure import` from `assets/enclosures/spark-case/source/full-2mm-flat.stl` (see `crates/deckpack-mesh/tests/spark_case.rs` for the exact command; the test fails if they drift). That mesh is the original `full-2mm.stl` with the printable-seam reinforcement pad removed by `scripts/flatten_spark_seam.py`. `scripts/generate_spark_enclosure.py` is the retired Python pipeline, kept for provenance only.
- Component visuals can use an STL, a top texture, or a procedural case without changing the collision geometry.

Libraries live in [`src/data/cells.json`](src/data/cells.json) and [`src/data/components.json`](src/data/components.json). Each sourced record carries the checked URL, date, and a note describing whether dimensions refer to a finished cell, PCB, or enclosure.

Third-party visual assets and their licenses are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
