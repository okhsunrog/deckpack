//! Finding room for components on the deck.
//!
//! Candidates are scanned on a coarse grid, preferring the ends of the deck
//! (where a centred pack leaves space) and the centre line, and the first
//! position that settles inside the enclosure without touching the pack or
//! other components wins. Used for the "add component" default in the app
//! and for greedy auto-placement.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::geometry::{component_fits, enclosure_bounds, pack_obstacles};
use crate::heightmap::{self, HeightMapError};
use crate::types::*;

/// Grid pitch of the candidate scan.
pub const SCAN_STEP_MM: f64 = 5.0;

#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlacementSuggestion {
    pub position: [f64; 2],
    pub rotation_deg: f64,
}

fn candidate(
    id: &str,
    component_id: &str,
    dimensions: &Dimensions3D,
    position: [f64; 2],
    rotation_deg: f64,
) -> ComponentPlacement {
    ComponentPlacement {
        id: id.to_owned(),
        component_id: component_id.to_owned(),
        position,
        rotation_deg,
        tilt_deg: 0.0,
        dimensions_mm: *dimensions,
    }
}

/// Where a new component of the given size can go, or `None` if nowhere.
pub fn suggest_placement(
    enclosure: &EnclosureSpec,
    plan: &PackPlan,
    existing: &[ComponentPlacement],
    dimensions: &Dimensions3D,
) -> Result<Option<PlacementSuggestion>, HeightMapError> {
    heightmap::ensure_compiled(enclosure)?;
    let container = enclosure_bounds(enclosure);
    let obstacles = pack_obstacles(plan);

    // Candidate centres on a grid, ordered deck ends first, then centre line.
    // Candidates sit on a grid aligned to the deck origin so suggested
    // coordinates read as round numbers.
    let mut positions: Vec<[f64; 2]> = Vec::new();
    let mut x = (container.min[0] / SCAN_STEP_MM).ceil() * SCAN_STEP_MM;
    while x <= container.max[0] {
        let mut y = (container.min[1] / SCAN_STEP_MM).ceil() * SCAN_STEP_MM;
        while y <= container.max[1] {
            positions.push([x, y]);
            y += SCAN_STEP_MM;
        }
        x += SCAN_STEP_MM;
    }
    positions.sort_by(|a, b| {
        b[0].abs()
            .total_cmp(&a[0].abs())
            .then(a[1].abs().total_cmp(&b[1].abs()))
            .then(a[0].total_cmp(&b[0]))
    });

    for rotation_deg in [0.0, 90.0] {
        // Skip positions whose flat footprint cannot fit the container at all.
        let (half_x, half_y) = if rotation_deg == 0.0 {
            (dimensions.length / 2.0, dimensions.width / 2.0)
        } else {
            (dimensions.width / 2.0, dimensions.length / 2.0)
        };
        for &position in &positions {
            if position[0] - half_x < container.min[0]
                || position[0] + half_x > container.max[0]
                || position[1] - half_y < container.min[1]
                || position[1] + half_y > container.max[1]
            {
                continue;
            }
            let probe = candidate("probe", "probe", dimensions, position, rotation_deg);
            if component_fits(enclosure, &obstacles, existing, &probe) {
                return Ok(Some(PlacementSuggestion {
                    position,
                    rotation_deg,
                }));
            }
        }
    }
    Ok(None)
}

/// A component to place: its future placement id, library id and size.
#[derive(Serialize, Deserialize, Type, JsonSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlacementRequest {
    pub id: String,
    pub component_id: String,
    pub dimensions_mm: Dimensions3D,
}

/// Greedily place components one after another, largest footprint first.
/// Components that fit nowhere are returned in the second list.
pub fn auto_place(
    enclosure: &EnclosureSpec,
    plan: &PackPlan,
    existing: &[ComponentPlacement],
    requests: &[PlacementRequest],
) -> Result<(Vec<ComponentPlacement>, Vec<PlacementRequest>), HeightMapError> {
    let mut order: Vec<&PlacementRequest> = requests.iter().collect();
    order.sort_by(|a, b| {
        let area = |d: &Dimensions3D| d.length * d.width;
        area(&b.dimensions_mm).total_cmp(&area(&a.dimensions_mm))
    });
    let mut placed: Vec<ComponentPlacement> = existing.to_vec();
    let mut new_placements = Vec::new();
    let mut unplaced = Vec::new();
    for request in order {
        match suggest_placement(enclosure, plan, &placed, &request.dimensions_mm)? {
            Some(suggestion) => {
                let placement = candidate(
                    &request.id,
                    &request.component_id,
                    &request.dimensions_mm,
                    suggestion.position,
                    suggestion.rotation_deg,
                );
                placed.push(placement.clone());
                new_placements.push(placement);
            }
            None => unplaced.push(request.clone()),
        }
    }
    Ok((new_placements, unplaced))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::evaluate_workspace;
    use crate::packing::enumerate_pack_plans;
    use crate::project::{box_enclosure, default_config};

    fn plans(config: &PlannerConfig) -> Vec<PackPlan> {
        let cell = crate::library::cell(&config.pack.cell_id).clone();
        enumerate_pack_plans(&EnumerationRequest {
            config: config.clone(),
            cell,
        })
        .unwrap()
        .plans
    }

    #[test]
    fn suggestion_is_collision_free_in_the_spark_case() {
        let config = default_config();
        let plan = &plans(&config)[0];
        let esc = crate::library::component("makerx-dv6s").unwrap();
        let suggestion = suggest_placement(&config.enclosure, plan, &[], &esc.dimensions_mm)
            .unwrap()
            .expect("room");
        let placement = candidate(
            "esc",
            &esc.id,
            &esc.dimensions_mm,
            suggestion.position,
            suggestion.rotation_deg,
        );
        let evaluation = evaluate_workspace(&config.enclosure, plan, &[placement]).unwrap();
        assert!(
            !evaluation.has_collision,
            "{suggestion:?} collides: {evaluation:?}"
        );
    }

    #[test]
    fn auto_place_fills_a_box_and_reports_the_rest() {
        let mut config = default_config();
        config.enclosure = box_enclosure(800.0, 210.0, 34.0);
        config.pack.parallel_count = 4;
        let plan = &plans(&config)[0];
        let requests: Vec<PlacementRequest> = crate::library::components()
            .iter()
            .take(4)
            .enumerate()
            .map(|(index, spec)| PlacementRequest {
                id: format!("c{index}"),
                component_id: spec.id.clone(),
                dimensions_mm: spec.dimensions_mm,
            })
            .collect();
        let (placed, unplaced) = auto_place(&config.enclosure, plan, &[], &requests).unwrap();
        assert!(!placed.is_empty());
        assert_eq!(placed.len() + unplaced.len(), requests.len());
        let evaluation = evaluate_workspace(&config.enclosure, plan, &placed).unwrap();
        assert!(!evaluation.has_collision);
    }

    #[test]
    fn oversized_component_has_no_place() {
        let config = default_config();
        let plan = &plans(&config)[0];
        let huge = Dimensions3D {
            length: 400.0,
            width: 50.0,
            height: 10.0,
        };
        assert!(
            suggest_placement(&config.enclosure, plan, &[], &huge)
                .unwrap()
                .is_none()
        );
    }
}
