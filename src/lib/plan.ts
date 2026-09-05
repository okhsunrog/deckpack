import type { PackPlan } from "../bindings";

export function formatFactors(factors: [number, number, number]): string {
  return factors.join("×");
}

/**
 * Stable identity of a lattice choice: survives tolerance and enclosure edits
 * that reshuffle plan ids, so the UI can keep the user's selection. Mirrors
 * `plan_signature` in deckpack-core.
 */
export function planSignature(plan: PackPlan): string {
  return [
    plan.packingMode,
    plan.orientation,
    plan.staggerRowAxis ?? "-",
    plan.parallelFactors.join("x"),
    plan.seriesFactors.join("x"),
    plan.anchor,
  ].join("|");
}
