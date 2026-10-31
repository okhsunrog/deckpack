// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import fixture from "../../fixtures/domain/enumerate/spark-12s3p-default.json";
import type { PackPlan, ProjectFile } from "../bindings";
import { commands } from "../bindings";
import { planSignature } from "../lib/plan";
import { DEFAULT_HOLDER_OPTIONS } from "../scene/holder-mesh";
import { usePlannerStore } from "../store/planner-store";
import { ProjectMenu } from "./ProjectMenu";

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

vi.mock("../data/defaults", async () => {
  const { default: data } =
    await import("../../fixtures/domain/enumerate/spark-12s3p-default.json");
  return { getDefaultConfig: () => structuredClone(data.request.config) };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: async () => "/project.json",
  save: async () => "/project.json",
}));
vi.mock("../bindings", () => ({
  commands: {
    recentProjects: vi.fn(),
    saveProject: vi.fn(),
    loadProject: vi.fn(),
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  usePlannerStore.getState().resetProject();
  vi.mocked(commands.recentProjects).mockResolvedValue([]);
});
afterEach(cleanup);

it("round-trips the chosen layout and holder settings through Save and Open", async () => {
  const selected = fixture.response.plans[1] as unknown as PackPlan;
  const key = planSignature(selected);
  usePlannerStore.getState().setSelectedPlan(selected.id, key);
  usePlannerStore.getState().setHolderOptions({ style: "edge", edgeStripWidthMm: 8 });
  usePlannerStore.getState().setHolderCsg({ rails: true });
  let saved!: ProjectFile;
  vi.mocked(commands.saveProject).mockImplementation(async (_path, project) => {
    saved = JSON.parse(JSON.stringify(project)) as ProjectFile;
    return { status: "ok", data: null };
  });
  vi.mocked(commands.loadProject).mockImplementation(async () => ({ status: "ok", data: saved }));
  render(<ProjectMenu />);
  fireEvent.click(screen.getByText("Сохранить"));
  await waitFor(() => expect(usePlannerStore.getState().projectPath).toBe("/project.json"));
  usePlannerStore.getState().resetProject();
  fireEvent.click(screen.getByText("Открыть"));
  await waitFor(() => expect(usePlannerStore.getState().selectedPlanKey).toBe(key));
  expect(usePlannerStore.getState().selectedPlanId).toBeUndefined();
  expect(usePlannerStore.getState().holderOptions).toMatchObject({
    style: "edge",
    edgeStripWidthMm: 8,
  });
  expect(usePlannerStore.getState().holderCsg).toEqual({ rails: true });
});

it("loads older project files using default holder settings", () => {
  usePlannerStore.getState().setHolderOptions({ style: "edge" });
  usePlannerStore.getState().setHolderCsg({ rails: true });
  const project = {
    schemaVersion: 2,
    config: structuredClone(fixture.request.config),
    components: [],
  } as unknown as ProjectFile;
  expect(usePlannerStore.getState().loadProject(project, "/old.json")).toBe(true);
  expect(usePlannerStore.getState().holderOptions).toEqual(DEFAULT_HOLDER_OPTIONS);
  expect(usePlannerStore.getState().holderCsg).toEqual({ rails: false });
});
