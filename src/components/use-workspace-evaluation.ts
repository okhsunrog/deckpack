import { useEffect, useState } from "react";
import {
  commands,
  type ComponentPlacement,
  type EnclosureSpec,
  type PackPlan,
  type WorkspaceEvaluation,
} from "../bindings";

/**
 * Collision / free-volume evaluation of the placed components, computed by
 * the Rust core over IPC. A result is exposed only for its matching inputs;
 * pending, failed and absent evaluations must not look like a valid workspace.
 */
export function useWorkspaceEvaluation(
  enclosure: EnclosureSpec,
  plan: PackPlan | undefined,
  placements: ComponentPlacement[],
): { evaluation?: WorkspaceEvaluation; loading: boolean; error?: string } {
  const [state, setState] = useState<{
    enclosure?: EnclosureSpec;
    plan?: PackPlan;
    placements?: ComponentPlacement[];
    evaluation?: WorkspaceEvaluation;
    error?: string;
    loading: boolean;
  }>({ loading: !!plan });

  useEffect(() => {
    let active = true;
    const inputs = { enclosure, plan, placements };
    setState({ ...inputs, loading: !!plan });
    if (!plan) return;
    commands
      .evaluateWorkspace(enclosure, plan, placements)
      .then((result) => {
        if (!active) return;
        if (result.status === "ok") {
          setState({ ...inputs, loading: false, evaluation: result.data });
        } else {
          console.error("Workspace evaluation failed", result.error);
          setState({ ...inputs, loading: false, error: result.error });
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        console.error("Workspace evaluation failed", error);
        setState({ ...inputs, loading: false, error: String(error) });
      });
    return () => {
      active = false;
    };
  }, [enclosure, plan, placements]);

  return state.enclosure === enclosure && state.plan === plan && state.placements === placements
    ? state
    : { loading: !!plan };
}
