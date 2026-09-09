//! `deckpack`: the pack planner from the command line.
//!
//! Every subcommand is a thin wrapper over `deckpack-core` / `deckpack-mesh`
//! and prints either a human-readable table or the same JSON the desktop app
//! exchanges with its Rust core (`--json`).

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand, ValueEnum};
use deckpack_core::geometry::{box_size, evaluate_workspace};
use deckpack_core::holder::generate_holder;
use deckpack_core::holder::{build_stl, compute_holder_pieces};
use deckpack_core::packing::enumerate_pack_plans;
use deckpack_core::project::{ProjectFile, box_enclosure, default_config, mesh_enclosure};
use deckpack_core::*;
use deckpack_mesh::{
    CsgOptions, DepthMapOptions, ImportOptions, RailSpan, build_piece, cells_stl,
    import_enclosure_stl,
};

#[derive(Parser)]
#[command(
    name = "deckpack",
    version,
    about = "Battery pack layout planner for electric longboards"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Enumerate feasible pack layouts and rank them.
    Plan(PlanArgs),
    /// Check the components of a project against one of its layouts.
    Evaluate(EvaluateArgs),
    /// Generate the printable cell holder (binary STL) for a layout.
    Holder(HolderArgs),
    /// Export the cells of a layout as cylinders (binary STL, app coordinates).
    Cells(CellsArgs),
    /// Enclosure assets: import an STL, inspect a height map.
    #[command(subcommand)]
    Enclosure(EnclosureCommand),
    /// Bundled cell and component libraries.
    #[command(subcommand)]
    Library(LibraryCommand),
}

#[derive(Args, Clone)]
struct ConfigArgs {
    /// Start from a project JSON exported by the app instead of the defaults.
    #[arg(long, value_name = "FILE")]
    project: Option<PathBuf>,
    /// Cell id from the library (see `deckpack library cells`).
    #[arg(long)]
    cell: Option<String>,
    /// Series groups.
    #[arg(long, short = 's')]
    series: Option<u32>,
    /// Cells per group.
    #[arg(long, short = 'p')]
    parallel: Option<u32>,
    /// Rectangular enclosure as LxWxH in millimetres, e.g. 800x210x34.
    #[arg(long = "box", value_name = "LxWxH", conflicts_with_all = ["enclosure", "enclosure_file"])]
    box_dims: Option<String>,
    /// Profiled enclosure by asset id (bundled: spark-case).
    #[arg(long, conflicts_with = "enclosure_file")]
    enclosure: Option<String>,
    /// Profiled enclosure from a height-map JSON produced by `enclosure import`.
    #[arg(long, value_name = "FILE")]
    enclosure_file: Option<PathBuf>,
    /// Cell axis.
    #[arg(long, value_enum)]
    orientation: Option<OrientationArg>,
    /// Lattice(s) to try; repeat the flag for both.
    #[arg(long = "mode", value_enum)]
    modes: Vec<ModeArg>,
    /// Maximum lattice layers.
    #[arg(long)]
    max_layers: Option<u32>,
    /// Loose staggered lattices (no spacer wall): slide a ramp-lifted end cell
    /// of the bottom row outward until the upper row comes out level.
    #[arg(long)]
    level: bool,
    /// Target centre of mass along the deck, millimetres from the middle.
    #[arg(long)]
    target_com: Option<f64>,
}

#[derive(Clone, Copy, ValueEnum)]
enum OrientationArg {
    Auto,
    X,
    Y,
    Z,
}

#[derive(Clone, Copy, ValueEnum, PartialEq)]
enum ModeArg {
    Brick,
    Staggered,
}

#[derive(Clone, Copy, ValueEnum)]
enum StyleArg {
    Full,
    Edge,
}

#[derive(Args)]
struct PlanArgs {
    #[command(flatten)]
    config: ConfigArgs,
    /// Print the full EnumerationResponse as JSON.
    #[arg(long)]
    json: bool,
    /// Rows to print in table mode.
    #[arg(long, default_value_t = 20)]
    limit: usize,
}

#[derive(Args)]
struct EvaluateArgs {
    /// Project JSON exported by the app.
    #[arg(long, value_name = "FILE")]
    project: PathBuf,
    /// Layout to check: rank (1-based) or plan id. Defaults to the top-ranked layout.
    #[arg(long, default_value = "1")]
    plan: String,
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct HolderArgs {
    #[command(flatten)]
    config: ConfigArgs,
    /// Layout to build the holder for: rank (1-based) or plan id.
    #[arg(long, default_value = "1")]
    plan: String,
    /// Output STL path.
    #[arg(short, long, value_name = "FILE")]
    output: PathBuf,
    #[arg(long, value_enum, default_value_t = StyleArg::Full)]
    style: StyleArg,
    /// Extra bore radius so cells drop in, millimetres.
    #[arg(long)]
    clearance: Option<f64>,
    /// Cell length left free at each end for nickel, millimetres.
    #[arg(long)]
    terminal_margin: Option<f64>,
    /// Also write every piece as its own STL into this directory.
    #[arg(long, value_name = "DIR")]
    pieces_dir: Option<PathBuf>,
    /// Print bed as WxD in millimetres (e.g. 220x220): report whether pieces fit straight or diagonally.
    #[arg(long, value_name = "WxD")]
    bed: Option<String>,
    /// Also generate a cap over the top layer.
    #[arg(long)]
    cap: bool,
    /// Build the per-piece STLs with CSG: end rails and screw holes (needs --pieces-dir).
    #[arg(long, requires = "pieces_dir")]
    csg: bool,
    /// Rail width at each end for --csg, millimetres (0 = no rails).
    #[arg(long, default_value_t = 8.0)]
    rail_width: f64,
    /// Screw hole diameter through the rails for --csg, millimetres (0 = none).
    #[arg(long, default_value_t = 3.2)]
    screw: f64,
    /// Add end rails (with screw holes) to the CSG pieces.
    #[arg(long, requires = "csg")]
    rails: bool,
    /// No interlayer spacers: the between-rows tolerance layers are zeroed so
    /// the upper rows nest directly in the lower ones, and only cradles are
    /// generated.
    #[arg(long)]
    no_spacers: bool,
    /// Thin web thickness in millimetres where no cell is near.
    #[arg(long)]
    web: Option<f64>,
    /// Cradle cusp height as a fraction of the bore radius (1 = to the cell centre).
    #[arg(long)]
    cusp_height: Option<f64>,
    /// Width of the edge bands in millimetres (edge style).
    #[arg(long)]
    band: Option<f64>,
}

#[derive(Args)]
struct CellsArgs {
    #[command(flatten)]
    config: ConfigArgs,
    /// Layout to export: rank (1-based) or plan id.
    #[arg(long, default_value = "1")]
    plan: String,
    /// Output STL path.
    #[arg(short, long, value_name = "FILE")]
    output: PathBuf,
    /// Facets around each cell.
    #[arg(long, default_value_t = 64)]
    segments: usize,
}

#[derive(Subcommand)]
enum EnclosureCommand {
    /// Sample an STL into a height-map asset JSON (plus the display mesh).
    Import {
        /// Source STL (open side facing −Z, long side along the source Y axis).
        input: PathBuf,
        /// Height-map asset JSON to write.
        #[arg(short, long, value_name = "FILE")]
        output: PathBuf,
        /// Also write the display mesh in app coordinates.
        #[arg(long, value_name = "FILE")]
        display: Option<PathBuf>,
        /// Asset id (defaults to the input file stem).
        #[arg(long)]
        id: Option<String>,
        #[arg(long)]
        label: Option<String>,
        /// Grid pitch in millimetres.
        #[arg(long, default_value_t = 0.5)]
        step: f64,
        /// Depth quantisation in millimetres.
        #[arg(long, default_value_t = 0.25)]
        quantization: f64,
    },
    /// Summarise a height-map asset JSON.
    Info { file: PathBuf },
}

#[derive(Subcommand)]
enum LibraryCommand {
    Cells {
        #[arg(long)]
        json: bool,
    },
    Components {
        #[arg(long)]
        json: bool,
    },
}

fn main() -> Result<()> {
    // `deckpack plan --json | head` must end quietly instead of panicking.
    #[cfg(unix)]
    // SAFETY: restoring the default disposition of SIGPIPE before any output.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
    match Cli::parse().command {
        Command::Plan(args) => plan(args),
        Command::Evaluate(args) => evaluate(args),
        Command::Holder(args) => holder(args),
        Command::Cells(args) => cells(args),
        Command::Enclosure(command) => enclosure(command),
        Command::Library(command) => library(command),
    }
}

/* ------------------------------------------------------------- helpers */

fn read_project(path: &Path) -> Result<ProjectFile> {
    let text =
        fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?;
    let project: ProjectFile = serde_json::from_str(&text)
        .with_context(|| format!("{} is not a Deckpack project", path.display()))?;
    if project.schema_version != deckpack_core::project::PROJECT_SCHEMA_VERSION {
        bail!("unsupported project schema {}", project.schema_version);
    }
    Ok(project)
}

fn register_asset_file(path: &Path) -> Result<HeightMapAsset> {
    let text =
        fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?;
    let asset: HeightMapAsset = serde_json::from_str(&text)
        .with_context(|| format!("{} is not a height-map asset", path.display()))?;
    assets::register(asset.clone());
    Ok(asset)
}

fn parse_box(spec: &str) -> Result<EnclosureSpec> {
    let parts: Vec<f64> = spec
        .split(['x', 'X', '×'])
        .map(|part| part.trim().parse::<f64>())
        .collect::<Result<_, _>>()
        .with_context(|| format!("--box expects LxWxH in millimetres, got `{spec}`"))?;
    let [length, width, height] = parts[..] else {
        bail!("--box expects exactly three dimensions")
    };
    Ok(box_enclosure(length, width, height))
}

fn build_config(args: &ConfigArgs) -> Result<PlannerConfig> {
    let mut config = match &args.project {
        Some(path) => read_project(path)?.config,
        None => default_config(),
    };
    if let Some(spec) = &args.box_dims {
        config.enclosure = parse_box(spec)?;
    }
    if let Some(id) = &args.enclosure {
        config.enclosure = mesh_enclosure(id)?;
    }
    if let Some(path) = &args.enclosure_file {
        let asset = register_asset_file(path)?;
        config.enclosure = mesh_enclosure(&asset.id)?;
    }
    if let Some(cell) = &args.cell {
        if !library::cells()
            .iter()
            .any(|candidate| &candidate.id == cell)
        {
            bail!("unknown cell `{cell}`; see `deckpack library cells`");
        }
        config.pack.cell_id = cell.clone();
    }
    if let Some(series) = args.series {
        config.pack.series_count = series;
    }
    if let Some(parallel) = args.parallel {
        config.pack.parallel_count = parallel;
    }
    if let Some(orientation) = args.orientation {
        config.pack.orientation = match orientation {
            OrientationArg::Auto => OrientationRequest::Auto,
            OrientationArg::X => OrientationRequest::X,
            OrientationArg::Y => OrientationRequest::Y,
            OrientationArg::Z => OrientationRequest::Z,
        };
    }
    if !args.modes.is_empty() {
        config.pack.packing_modes = args
            .modes
            .iter()
            .map(|mode| match mode {
                ModeArg::Brick => PackingMode::Brick,
                ModeArg::Staggered => PackingMode::Staggered,
            })
            .collect();
    }
    if let Some(layers) = args.max_layers {
        config.pack.max_layers = layers;
    }
    if args.level {
        config.pack.level_upper_rows = true;
    }
    if let Some(target) = args.target_com {
        config.pack.target_center_of_mass_x_mm = target;
    }
    Ok(config)
}

fn enumerate(config: &PlannerConfig) -> Result<EnumerationResponse> {
    let cell = library::cell(&config.pack.cell_id).clone();
    Ok(enumerate_pack_plans(&EnumerationRequest {
        config: config.clone(),
        cell,
    })?)
}

/// Pick a plan by 1-based rank or by id.
fn select_plan<'a>(plans: &'a [PackPlan], selector: &str) -> Result<&'a PackPlan> {
    if let Ok(rank) = selector.parse::<usize>() {
        return plans
            .get(rank.checked_sub(1).context("plan rank starts at 1")?)
            .with_context(|| {
                format!(
                    "only {} layouts fit; rank {rank} does not exist",
                    plans.len()
                )
            });
    }
    plans
        .iter()
        .find(|plan| plan.id == selector)
        .with_context(|| format!("no layout with id `{selector}`"))
}

fn axis_name(axis: Axis) -> &'static str {
    match axis {
        Axis::X => "x",
        Axis::Y => "y",
        Axis::Z => "z",
    }
}

fn print_json<T: serde::Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

/* ------------------------------------------------------------ commands */

fn plan(args: PlanArgs) -> Result<()> {
    let config = build_config(&args.config)?;
    let response = enumerate(&config)?;
    if args.json {
        return print_json(&response);
    }
    let cell = library::cell(&config.pack.cell_id);
    println!(
        "{}S{}P × {} in {} · {} explored, {} fit",
        config.pack.series_count,
        config.pack.parallel_count,
        cell.model,
        describe_enclosure(&config.enclosure),
        response.explored_count,
        response.plans.len()
    );
    if response.plans.is_empty() {
        return Ok(());
    }
    println!(
        "{:>3} {:>5} {:<9} {:<3} {:<7} {:<7} {:<7} {:>3} {:>8} {:>7} {:>6} {:<18} id",
        "#",
        "score",
        "lattice",
        "ax",
        "P",
        "S",
        "anchor",
        "lyr",
        "CoM mm",
        "chain",
        "gap",
        "bounds mm"
    );
    for (index, plan) in response.plans.iter().take(args.limit).enumerate() {
        let size = box_size(&plan.bounds);
        println!(
            "{:>3} {:>5} {:<9} {:<3} {:<7} {:<7} {:<7} {:>3} {:>8.1} {:>7.0} {:>6.1} {:<18} {}",
            index + 1,
            plan.metrics.score,
            match plan.packing_mode {
                PackingMode::Brick => "brick",
                PackingMode::Staggered => "staggered",
            },
            axis_name(plan.orientation),
            format!(
                "{}×{}×{}",
                plan.parallel_factors[0], plan.parallel_factors[1], plan.parallel_factors[2]
            ),
            format!(
                "{}×{}×{}",
                plan.series_factors[0], plan.series_factors[1], plan.series_factors[2]
            ),
            format!("{:?}", plan.anchor).to_lowercase(),
            plan.metrics.layer_count,
            plan.metrics.center_of_mass_x_mm,
            plan.metrics.series_chain_length_mm,
            plan.metrics.min_clearance_mm,
            format!("{:.0}×{:.0}×{:.0}", size[0], size[1], size[2]),
            plan.id
        );
    }
    if response.plans.len() > args.limit {
        println!(
            "… {} more (raise --limit or use --json)",
            response.plans.len() - args.limit
        );
    }
    Ok(())
}

fn describe_enclosure(enclosure: &EnclosureSpec) -> String {
    let d = enclosure.dimensions_mm();
    match enclosure {
        EnclosureSpec::Box { .. } => {
            format!("box {:.0}×{:.0}×{:.0} mm", d.length, d.width, d.height)
        }
        EnclosureSpec::MeshHeightmap { asset_id, .. } => {
            format!(
                "{asset_id} ({:.1}×{:.1}×{:.1} mm)",
                d.length, d.width, d.height
            )
        }
    }
}

fn evaluate(args: EvaluateArgs) -> Result<()> {
    let project = read_project(&args.project)?;
    let response = enumerate(&project.config)?;
    let plan = select_plan(&response.plans, &args.plan)?;
    let evaluation = evaluate_workspace(&project.config.enclosure, plan, &project.components)?;
    if args.json {
        return print_json(&evaluation);
    }
    println!(
        "layout {} · {} components · free {:.2} l ({:.0} %) · {}",
        plan.id,
        evaluation.components.len(),
        evaluation.free_volume_mm3 / 1e6,
        evaluation.free_percent,
        if evaluation.has_collision {
            "COLLISIONS"
        } else {
            "clean"
        }
    );
    for (component, placement) in evaluation.components.iter().zip(&project.components) {
        let spec = library::component(&placement.component_id)
            .map(|spec| spec.model.as_str())
            .unwrap_or("custom");
        let state = match (component.collides, component.outside) {
            (false, false) => "ok",
            (true, false) => "collides",
            (false, true) => "outside",
            (true, true) => "collides, outside",
        };
        println!(
            "  {:<28} {:<24} x {:>7.1} y {:>7.1} z {:>6.1}..{:<6.1} {}",
            component.id,
            spec,
            placement.position[0],
            placement.position[1],
            component.box_.min[2],
            component.box_.max[2],
            state
        );
    }
    Ok(())
}

fn holder(args: HolderArgs) -> Result<()> {
    let mut config = build_config(&args.config)?;
    if args.no_spacers {
        for layer in &mut config.pack.tolerance_stack {
            if layer.application == ToleranceApplication::BetweenRows {
                layer.thickness_mm = 0.0;
            }
        }
    }
    let response = enumerate(&config)?;
    let plan = select_plan(&response.plans, &args.plan)?;
    let cell = library::cell(&config.pack.cell_id);
    let mut options = HolderOptions {
        style: match args.style {
            StyleArg::Full => HolderStyle::Full,
            StyleArg::Edge => HolderStyle::Edge,
        },
        ..HolderOptions::default()
    };
    if let Some(clearance) = args.clearance {
        options.clearance_mm = clearance;
    }
    if let Some(margin) = args.terminal_margin {
        options.terminal_margin_mm = margin;
    }
    options.cap = args.cap;
    options.spacers = !args.no_spacers;
    if let Some(web) = args.web {
        options.web_mm = web;
    }
    if let Some(fraction) = args.cusp_height {
        options.cusp_height = fraction;
    }
    if let Some(band) = args.band {
        options.edge_strip_width_mm = band;
    }
    let build = generate_holder(
        plan,
        cell,
        &config.pack.tolerance_stack,
        &config.enclosure,
        &options,
    )?;
    fs::write(&args.output, &build.stl)
        .with_context(|| format!("cannot write {}", args.output.display()))?;
    println!(
        "{} · {} pieces · {} bytes",
        args.output.display(),
        build.pieces.len(),
        build.stl.len()
    );
    for piece in &build.pieces {
        println!(
            "  {:<24} {:>6} tris  {:.1}×{:.1}×{:.1} mm  min wall {:.2} mm",
            piece.label,
            piece.triangle_count,
            piece.size_mm[0],
            piece.size_mm[1],
            piece.size_mm[2],
            piece.min_wall_mm
        );
    }
    let mut csg_sizes: Option<Vec<(String, [f64; 3])>> = None;
    if let Some(dir) = &args.pieces_dir {
        fs::create_dir_all(dir).with_context(|| format!("cannot create {}", dir.display()))?;
        let layout = compute_holder_pieces(
            plan,
            cell,
            &config.pack.tolerance_stack,
            &config.enclosure,
            &options,
        )?;
        if args.csg {
            let csg = CsgOptions {
                rail_width_mm: if args.rails { args.rail_width } else { 0.0 },
                screw_diameter_mm: args.screw,
                ..CsgOptions::default()
            };
            let started = std::time::Instant::now();
            let span = RailSpan::of(&layout.pieces);
            let mut sizes = Vec::new();
            for piece in &layout.pieces {
                let built = build_piece(piece, &csg, span)?;
                sizes.push((built.report.label.clone(), built.report.size_mm));
                let path = dir.join(format!("{}.stl", piece.label));
                fs::write(&path, &built.stl)
                    .with_context(|| format!("cannot write {}", path.display()))?;
                let r = &built.report;
                println!(
                    "  csg {:<22} {:>6} tris  {:.1}×{:.1}×{:.1} mm  {:.1} cm³  holes {}",
                    r.label,
                    r.triangles,
                    r.size_mm[0],
                    r.size_mm[1],
                    r.size_mm[2],
                    r.volume_mm3 / 1000.0,
                    r.genus
                );
            }
            csg_sizes = Some(sizes);
            println!(
                "{} CSG pieces written to {} in {:.0} ms",
                layout.pieces.len(),
                dir.display(),
                started.elapsed().as_secs_f64() * 1000.0
            );
        } else {
            for piece in &layout.pieces {
                let single = build_stl(std::slice::from_ref(piece), &options);
                let path = dir.join(format!("{}.stl", piece.label));
                fs::write(&path, &single.stl)
                    .with_context(|| format!("cannot write {}", path.display()))?;
            }
            println!(
                "{} pieces written to {}",
                layout.pieces.len(),
                dir.display()
            );
        }
    }
    if let Some(bed) = &args.bed {
        let sizes: Vec<(String, [f64; 3])> = match &csg_sizes {
            Some(sizes) => sizes.clone(),
            None => build
                .pieces
                .iter()
                .map(|p| (p.label.clone(), p.size_mm))
                .collect(),
        };
        report_bed_fit(bed, &sizes)?;
    }
    if build.thinnest_wall_mm < options.min_wall_mm.max(0.4) {
        eprintln!(
            "warning: thinnest wall is {:.2} mm. The cradle base under the cells is the «Дно холдера» \
             tolerance layer; raise it to at least {:.1} mm (if the pack still fits the lid) or the comb \
             prints as separate cusps.",
            build.thinnest_wall_mm,
            options.min_wall_mm.max(0.8)
        );
    }
    Ok(())
}

fn enclosure(command: EnclosureCommand) -> Result<()> {
    match command {
        EnclosureCommand::Import {
            input,
            output,
            display,
            id,
            label,
            step,
            quantization,
        } => {
            let bytes =
                fs::read(&input).with_context(|| format!("cannot read {}", input.display()))?;
            let stem = input
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("enclosure")
                .to_owned();
            let options = ImportOptions {
                id: id.unwrap_or_else(|| stem.clone()),
                label: label.unwrap_or(stem),
                model_url: String::new(),
                depth: DepthMapOptions {
                    step_mm: step,
                    quantization_mm: quantization,
                    ..DepthMapOptions::default()
                },
            };
            let imported = import_enclosure_stl(&bytes, &options)?;
            let mut asset = imported.asset;
            if let Some(display) = &display {
                fs::write(display, &imported.display_stl)
                    .with_context(|| format!("cannot write {}", display.display()))?;
                asset.model_path = Some(display.canonicalize()?.to_string_lossy().into_owned());
            }
            fs::write(&output, serde_json::to_vec(&asset)?)
                .with_context(|| format!("cannot write {}", output.display()))?;
            print_asset(&asset);
            Ok(())
        }
        EnclosureCommand::Info { file } => {
            let asset = register_asset_file(&file)?;
            print_asset(&asset);
            Ok(())
        }
    }
}

fn print_asset(asset: &HeightMapAsset) {
    let d = &asset.dimensions_mm;
    let m = &asset.depth_map;
    println!("{} · {}", asset.id, asset.label);
    println!(
        "  inner box  {:.1} × {:.1} × {:.1} mm",
        d.length, d.width, d.height
    );
    println!(
        "  grid       {} × {} @ {} mm, depth step {} mm",
        m.columns, m.rows, m.step_mm, m.depth_quantization_mm
    );
    println!(
        "  depth      {:.2} .. {:.2} mm",
        m.min_depth_mm, m.max_depth_mm
    );
    println!("  usable     {:.3} l", m.usable_volume_mm3 / 1e6);
    println!("  mesh       {} triangles", asset.mesh_triangles);
}

fn library(command: LibraryCommand) -> Result<()> {
    match command {
        LibraryCommand::Cells { json } => {
            if json {
                return print_json(&library::cells());
            }
            for cell in library::cells() {
                println!(
                    "{:<14} {:<28} Ø{:.2} × {:.2} mm  {} g  {:.2} V  {:.1} Ah",
                    cell.id,
                    cell.model,
                    cell.sleeved_diameter_mm,
                    cell.sleeved_height_mm,
                    cell.mass_g,
                    cell.nominal_voltage_v,
                    cell.capacity_ah
                );
            }
        }
        LibraryCommand::Components { json } => {
            if json {
                return print_json(&library::components());
            }
            for component in library::components() {
                let d = &component.dimensions_mm;
                println!(
                    "{:<20} {:<10} {:<26} {:.0} × {:.0} × {:.0} mm",
                    component.id,
                    format!("{:?}", component.category).to_lowercase(),
                    component.model,
                    d.length,
                    d.width,
                    d.height
                );
            }
        }
    }
    Ok(())
}

fn cells(args: CellsArgs) -> Result<()> {
    let config = build_config(&args.config)?;
    let response = enumerate(&config)?;
    let plan = select_plan(&response.plans, &args.plan)?;
    let cell = library::cell(&config.pack.cell_id);
    let stl = cells_stl(plan, cell, args.segments);
    fs::write(&args.output, &stl)
        .with_context(|| format!("cannot write {}", args.output.display()))?;
    println!(
        "{} · {} cells of {} as {}-facet cylinders · {} bytes",
        args.output.display(),
        plan.cells.len(),
        cell.model,
        args.segments,
        stl.len()
    );
    Ok(())
}

/// Can each piece be printed on a `WxD` bed, straight or rotated 45°, and how
/// many strips share one plate diagonally?
fn report_bed_fit(bed: &str, pieces: &[(String, [f64; 3])]) -> Result<()> {
    let dims: Vec<f64> = bed
        .split(['x', 'X', '×'])
        .map(|part| part.trim().parse::<f64>())
        .collect::<Result<_, _>>()
        .with_context(|| format!("--bed expects WxD in millimetres, got `{bed}`"))?;
    let [width, depth] = dims[..] else {
        bail!("--bed expects exactly two dimensions")
    };
    let side = width.min(depth);
    let gap = 3.0;
    println!("bed {width:.0}×{depth:.0} mm:");
    for (label, size) in pieces {
        let (l, w, h) = (size[0], size[1], size[2]);
        let straight = (l <= width && w <= depth) || (l <= depth && w <= width);
        let diagonal = (l + w) / 2f64.sqrt() <= side;
        // Parallel diagonal strips at pitch w + gap: the outermost strip still
        // needs l + w + (n - 1)(w + gap) <= side·√2.
        let per_plate = if diagonal {
            (((side * 2f64.sqrt() - l - w) / (w + gap)).floor() as usize + 1).max(1)
        } else {
            0
        };
        let verdict = if straight {
            "fits straight".to_owned()
        } else if diagonal {
            format!("fits at 45° only, up to {per_plate} per plate")
        } else {
            "does not fit".to_owned()
        };
        println!("  {:<24} {:.0}×{:.0}×{:.0} mm  {}", label, l, w, h, verdict);
    }
    Ok(())
}
