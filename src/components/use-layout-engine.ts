import { useEffect, useRef, useState } from "react";
import type { CellSpec, EnumerationResponse, PackPlan, PlannerConfig } from "../domain/types";

interface LayoutEngineState {
  plans: PackPlan[];
  exploredCount: number;
  loading: boolean;
}

const initialState: LayoutEngineState = { plans: [], exploredCount: 0, loading: true };

export function useLayoutEngine(config: PlannerConfig, cell: CellSpec): LayoutEngineState {
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const [state, setState] = useState(initialState);

  useEffect(() => {
    const worker = new Worker(new URL("../worker/layout-worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<EnumerationResponse & { requestId?: number }>) => {
      if (event.data.requestId !== undefined && event.data.requestId !== requestIdRef.current)
        return;
      setState({ ...event.data, loading: false });
    };
    // A crashed enumeration must not leave the UI in an endless loading state.
    worker.onerror = (event) => {
      console.error("Layout worker failed", event);
      setState((current) => ({ ...current, loading: false }));
    };
    worker.onmessageerror = (event) => {
      console.error("Layout worker message failed", event);
      setState((current) => ({ ...current, loading: false }));
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState((current) => ({ ...current, loading: true }));
    workerRef.current?.postMessage({ config, cell, requestId });
  }, [config, cell]);

  return state;
}
