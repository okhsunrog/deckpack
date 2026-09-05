import { useEffect, useRef, useState } from "react";
import { commands } from "../bindings";
import type { CellSpec, EnumerationResponse, PackPlan, PlannerConfig } from "../domain/types";

interface LayoutEngineState {
  plans: PackPlan[];
  exploredCount: number;
  loading: boolean;
}

const initialState: LayoutEngineState = { plans: [], exploredCount: 0, loading: true };

/**
 * Layout enumeration by the Rust core. Every config change issues a new
 * request; responses that arrive for an outdated request are ignored, and a
 * failure never leaves the UI in an endless loading state.
 */
export function useLayoutEngine(config: PlannerConfig, cell: CellSpec): LayoutEngineState {
  const requestIdRef = useRef(0);
  const [state, setState] = useState(initialState);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState((current) => ({ ...current, loading: true }));
    commands
      .enumeratePlans({ config, cell })
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        if (result.status === "ok") {
          setState({ ...(result.data as EnumerationResponse), loading: false });
        } else {
          console.error("Layout enumeration failed", result.error);
          setState((current) => ({ ...current, loading: false }));
        }
      })
      .catch((error: unknown) => {
        if (requestIdRef.current !== requestId) return;
        console.error("Layout enumeration failed", error);
        setState((current) => ({ ...current, loading: false }));
      });
  }, [config, cell]);

  return state;
}
