import { useEffect, useRef, useState } from "react";
import type {
  CellSpec,
  EnclosureSpec,
  HolderCsg,
  HolderOptions,
  PackPlan,
  ToleranceLayer,
} from "../bindings";
import { fetchHolderMesh } from "./holder-mesh";

/** Holder triangles for the plan; `undefined` while pending or for vertical packs. */
export function useHolderMesh(
  plan: PackPlan,
  cell: CellSpec,
  toleranceStack: ToleranceLayer[],
  enclosure: EnclosureSpec,
  options: HolderOptions,
  csg: HolderCsg,
): Float32Array | undefined {
  const [positions, setPositions] = useState<Float32Array>();
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    if (plan.orientation === "z") {
      setPositions(undefined);
      return;
    }
    fetchHolderMesh(plan, cell, toleranceStack, enclosure, options, csg)
      .then((result) => {
        if (requestIdRef.current === requestId) setPositions(result);
      })
      .catch((error: unknown) => {
        if (requestIdRef.current === requestId) console.error("Holder mesh failed", error);
      });
  }, [plan, cell, toleranceStack, enclosure, options, csg]);

  return positions;
}
