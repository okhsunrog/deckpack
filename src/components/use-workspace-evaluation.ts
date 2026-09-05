import { useEffect, useRef, useState } from "react";
import { commands } from "../bindings";
import type {
  ComponentPlacement,
  EnclosureSpec,
  PackPlan,
  WorkspaceEvaluation,
} from "../domain/types";

/**
 * Collision / free-volume evaluation of the placed components, computed by
 * the Rust core over IPC. The previous result stays visible while a newer
 * request is in flight, and stale responses are dropped.
 */
export function useWorkspaceEvaluation(
  enclosure: EnclosureSpec,
  plan: PackPlan | undefined,
  placements: ComponentPlacement[],
): WorkspaceEvaluation | undefined {
  const [evaluation, setEvaluation] = useState<WorkspaceEvaluation>();
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!plan) {
      setEvaluation(undefined);
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    commands
      .evaluateWorkspace(enclosure, plan, placements)
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        if (result.status === "ok") {
          setEvaluation(result.data as WorkspaceEvaluation);
        } else {
          console.error("Workspace evaluation failed", result.error);
        }
      })
      .catch((error: unknown) => {
        if (requestIdRef.current === requestId) console.error("Workspace evaluation failed", error);
      });
  }, [enclosure, plan, placements]);

  return evaluation;
}
