// @vitest-environment happy-dom
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import fixture from "../fixtures/domain/enumerate/spark-12s3p-default.json";
import type {
  ComponentPlacement,
  EnumerationRequest,
  EnumerationResponse,
  PackPlan,
  WorkspaceEvaluation,
} from "./bindings";
import { commands } from "./bindings";
import { useWorkspaceEvaluation } from "./components/use-workspace-evaluation";
import { useLayoutEngine } from "./components/use-layout-engine";
import App from "./App";
import { usePlannerStore } from "./store/planner-store";
import { planSignature } from "./lib/plan";

vi.hoisted(() => {
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
      removeItem: (key: string) => memory.delete(key),
    },
  });
});

vi.mock("./bindings", () => ({
  commands: { enumeratePlans: vi.fn(), evaluateWorkspace: vi.fn() },
}));
vi.mock("./data/defaults", async () => {
  const { default: data } = await import("../fixtures/domain/enumerate/spark-12s3p-default.json");
  return { getDefaultConfig: () => structuredClone(data.request.config) };
});
vi.mock("./components/ControlPanel", () => ({ ControlPanel: () => null }));
vi.mock("./components/ProjectMenu", () => ({ ProjectMenu: () => null }));
vi.mock("./scene/PlannerScene", () => ({ PlannerScene: () => null }));

const { request, response } = fixture as unknown as {
  request: EnumerationRequest;
  response: EnumerationResponse;
};
const emptyEvaluation: WorkspaceEvaluation = {
  components: [],
  hasCollision: false,
  freeVolumeMm3: 1,
  freePercent: 100,
  largestFreeBox: { box: { min: [0, 0, 0], max: [0, 0, 0] }, volumeMm3: 0 },
};

beforeEach(() => {
  vi.resetAllMocks();
  usePlannerStore.getState().resetProject();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("reports no feasible layout instead of validating an absent plan", async () => {
  vi.mocked(commands.enumeratePlans).mockResolvedValue({
    status: "ok",
    data: { plans: [], exploredCount: 10 },
  });
  render(<App />);
  await screen.findByText("Нет подходящих раскладок");
  expect(screen.queryByText("Геометрия валидна")).toBeNull();
  expect(commands.evaluateWorkspace).not.toHaveBeenCalled();
});

it("does not report collision checks as passed when there is no evaluation", async () => {
  usePlannerStore.getState().setRightPanel("components");
  vi.mocked(commands.enumeratePlans).mockResolvedValue({
    status: "ok",
    data: { plans: [], exploredCount: 0 },
  });
  render(<App />);
  await screen.findByText("Нет подходящих раскладок");
  expect(screen.getByText("Нет результата проверки")).toBeTruthy();
  expect(screen.queryByText("Коллизий нет")).toBeNull();
});

it("reports enumeration failures instead of treating them as a valid workspace", async () => {
  vi.mocked(commands.enumeratePlans).mockResolvedValue({ status: "error", error: "bad enclosure" });
  render(<App />);
  await screen.findByText("Ошибка перебора геометрии");
  expect(screen.queryByText("Геометрия валидна")).toBeNull();
});

it("waits for a successful evaluation before reporting valid geometry", async () => {
  vi.mocked(commands.enumeratePlans).mockResolvedValue({ status: "ok", data: response });
  let resolve!: (value: Awaited<ReturnType<typeof commands.evaluateWorkspace>>) => void;
  vi.mocked(commands.evaluateWorkspace).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(<App />);
  await screen.findByText("Проверка геометрии…");
  expect(screen.queryByText("Геометрия валидна")).toBeNull();
  await act(async () => {
    resolve({ status: "ok", data: emptyEvaluation });
  });
  expect(screen.getByText("Геометрия валидна")).toBeTruthy();
});

it("reports workspace evaluation failures", async () => {
  vi.mocked(commands.enumeratePlans).mockResolvedValue({ status: "ok", data: response });
  vi.mocked(commands.evaluateWorkspace).mockRejectedValue(new Error("IPC failed"));
  render(<App />);
  await screen.findByText("Ошибка проверки геометрии");
  expect(screen.queryByText("Геометрия валидна")).toBeNull();
});

it("restores a saved layout instead of choosing the highest-ranked one", async () => {
  const selected = response.plans[1];
  usePlannerStore.getState().loadProject(
    {
      schemaVersion: 2,
      config: request.config,
      components: [],
      selectedPlanKey: planSignature(selected),
    },
    "/project.json",
  );
  vi.mocked(commands.enumeratePlans).mockResolvedValue({ status: "ok", data: response });
  vi.mocked(commands.evaluateWorkspace).mockResolvedValue({ status: "ok", data: emptyEvaluation });
  render(<App />);
  await screen.findByText("Геометрия валидна");
  expect(vi.mocked(commands.evaluateWorkspace).mock.calls[0][1].id).toBe(selected.id);
});

it("clears the previous layouts when a changed configuration fails", async () => {
  vi.mocked(commands.enumeratePlans)
    .mockResolvedValueOnce({ status: "ok", data: response })
    .mockRejectedValueOnce(new Error("IPC failed"));
  const { result, rerender } = renderHook(({ config }) => useLayoutEngine(config, request.cell), {
    initialProps: { config: request.config },
  });
  await waitFor(() => expect(result.current.plans).toHaveLength(response.plans.length));
  rerender({ config: { ...request.config, pack: { ...request.config.pack, seriesCount: 13 } } });
  await waitFor(() => expect(result.current.error).toBe("Error: IPC failed"));
  expect(result.current.plans).toHaveLength(0);
  expect(result.current.loading).toBe(false);
});

it("discards an evaluation that completes after the plan disappears", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof commands.evaluateWorkspace>>) => void;
  vi.mocked(commands.evaluateWorkspace).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const placements: ComponentPlacement[] = [];
  const { result, rerender } = renderHook(
    ({ plan }: { plan?: PackPlan }) =>
      useWorkspaceEvaluation(request.config.enclosure, plan, placements),
    { initialProps: { plan: response.plans[0] as PackPlan | undefined } },
  );
  await waitFor(() => expect(commands.evaluateWorkspace).toHaveBeenCalled());
  rerender({ plan: undefined });
  await act(async () => {
    resolve({ status: "ok", data: emptyEvaluation });
  });
  expect(result.current.evaluation).toBeUndefined();
  expect(result.current.loading).toBe(false);
});
