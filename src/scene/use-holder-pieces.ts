import { useEffect, useRef, useState } from "react";
import {
  commands,
  type CellSpec,
  type EnclosureSpec,
  type HolderOptions,
  type HolderPieces,
  type PackPlan,
  type ToleranceLayer,
} from "../bindings";

/** Default print options, mirrored from `HolderOptions::default()` in Rust. */
export const DEFAULT_HOLDER_OPTIONS: HolderOptions = {
  clearanceMm: 0.25,
  terminalMarginMm: 7,
  layoutGapMm: 8,
  sampleStepMm: 0.25,
  style: "full",
  edgeStripWidthMm: 12,
};

/**
 * Holder wave profiles for the plan, computed by the Rust core. Vertical
 * packs have no holder and yield `undefined`, as does a pending request.
 */
export function useHolderPieces(
  plan: PackPlan,
  cell: CellSpec,
  toleranceStack: ToleranceLayer[],
  enclosure: EnclosureSpec,
  options: HolderOptions,
): HolderPieces | undefined {
  const [pieces, setPieces] = useState<HolderPieces>();
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    if (plan.orientation === "z") {
      setPieces(undefined);
      return;
    }
    commands
      .holderPieces(plan, cell, toleranceStack, enclosure, options)
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        if (result.status === "ok") setPieces(result.data);
        else console.error("Holder profiles failed", result.error);
      })
      .catch((error: unknown) => {
        if (requestIdRef.current === requestId) console.error("Holder profiles failed", error);
      });
  }, [plan, cell, toleranceStack, enclosure, options]);

  return pieces;
}
