import { useEffect, useState } from "react";
import { commands, type CellSpec, type PackPlan, type PlannerConfig } from "../bindings";

interface LayoutEngineState {
  plans: PackPlan[];
  exploredCount: number;
  loading: boolean;
  error?: string;
}

const initialState: LayoutEngineState = { plans: [], exploredCount: 0, loading: true };

/**
 * Layout enumeration by the Rust core. Every config change issues a new
 * request; responses that arrive for an outdated request are ignored, and a
 * failure never leaves the UI in an endless loading state.
 */
export function useLayoutEngine(config: PlannerConfig, cell: CellSpec): LayoutEngineState {
  const [state, setState] = useState<
    LayoutEngineState & { config?: PlannerConfig; cell?: CellSpec }
  >(initialState);

  useEffect(() => {
    let active = true;
    setState({ ...initialState, config, cell });
    commands
      .enumeratePlans({ config, cell })
      .then((result) => {
        if (!active) return;
        if (result.status === "ok") {
          setState({ ...result.data, loading: false, config, cell });
        } else {
          console.error("Layout enumeration failed", result.error);
          setState({
            plans: [],
            exploredCount: 0,
            loading: false,
            error: result.error,
            config,
            cell,
          });
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        console.error("Layout enumeration failed", error);
        setState({
          plans: [],
          exploredCount: 0,
          loading: false,
          error: String(error),
          config,
          cell,
        });
      });
    return () => {
      active = false;
    };
  }, [config, cell]);

  return state.config === config && state.cell === cell ? state : initialState;
}
