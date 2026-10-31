use deckpack_core::{holder, library, packing, project, *};
use deckpack_mesh::{CsgOptions, assembled_positions, build_holder};

#[test]
fn default_profiled_layouts_build_with_and_without_rails() {
    let config = project::default_config();
    let cell = library::cell(&config.pack.cell_id).clone();
    let response = packing::enumerate_pack_plans(&EnumerationRequest {
        config: config.clone(),
        cell: cell.clone(),
    })
    .unwrap();
    assert!(!response.plans.is_empty());
    for plan in &response.plans {
        let layout = holder::compute_holder_pieces(
            plan,
            &cell,
            &config.pack.tolerance_stack,
            &config.enclosure,
            &HolderOptions::default(),
        )
        .unwrap();
        for rail_width_mm in [0.0, 8.0] {
            let built = build_holder(
                &layout,
                &CsgOptions {
                    rail_width_mm,
                    ..CsgOptions::default()
                },
            )
            .unwrap();
            assert_eq!(built.len(), layout.pieces.len());
            assert!(built.iter().all(|piece| piece.report.volume_mm3 > 0.0));
            assert!(!assembled_positions(&layout, &built).is_empty());
        }
    }
}

#[test]
fn zero_wrap_holder_preserves_cell_cutouts() {
    let mut config = project::default_config();
    config.enclosure = project::box_enclosure(300.0, 100.0, 30.0);
    config.pack.series_count = 1;
    config.pack.parallel_count = 3;
    config.pack.orientation = OrientationRequest::Y;
    config.pack.packing_modes = vec![PackingMode::Brick];
    for layer in &mut config.pack.tolerance_stack {
        if layer.application == ToleranceApplication::AllFaces {
            layer.thickness_mm = 0.0;
        }
    }
    let cell = library::cell(&config.pack.cell_id).clone();
    let response = packing::enumerate_pack_plans(&EnumerationRequest {
        config: config.clone(),
        cell: cell.clone(),
    })
    .unwrap();
    let plan = &response.plans[0];
    let layout = holder::compute_holder_pieces(
        plan,
        &cell,
        &config.pack.tolerance_stack,
        &config.enclosure,
        &HolderOptions::default(),
    )
    .unwrap();
    let built = build_holder(
        &layout,
        &CsgOptions {
            rail_width_mm: 0.0,
            ..CsgOptions::default()
        },
    )
    .unwrap();
    assert!(built.iter().all(|piece| piece.report.volume_mm3 > 0.0));
    let positions = assembled_positions(&layout, &built);
    assert!(!positions.is_empty());
    for p in positions.as_chunks::<3>().0 {
        for placed in &plan.cells {
            if (p[1] as f64 - placed.position[1]).abs() >= cell.sleeved_height_mm / 2.0 {
                continue;
            }
            let radius = ((p[0] as f64 - placed.position[0]).powi(2)
                + (p[2] as f64 - placed.position[2]).powi(2))
            .sqrt();
            assert!(
                radius >= cell.sleeved_diameter_mm / 2.0 - 1e-5,
                "holder intersects cell {} by {} mm",
                placed.id,
                cell.sleeved_diameter_mm / 2.0 - radius
            );
        }
    }
}
