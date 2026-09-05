import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  createDefaultServiceReservations,
  setWiringExitMode as updateWiringExitMode,
} from "./service-reservations";
import { createMeshEnclosure, createSparkCaseEnclosure } from "../data/enclosures";
import { sanitizePersistedConfig, sanitizePersistedPlacements } from "./persisted-state";
import type {
  ComponentPlacement,
  ComponentSpec,
  Dimensions3D,
  EnclosureSpec,
  ProjectFile,
  PackRequest,
  PlannerConfig,
  ServiceReservation,
  ToleranceLayer,
  WiringExitMode,
  HolderStyle,
} from "../bindings";

export const defaultConfig: PlannerConfig = {
  enclosure: createSparkCaseEnclosure(),
  pack: {
    seriesCount: 12,
    parallelCount: 3,
    cellId: "eve-50pl",
    orientation: "auto",
    packingModes: ["brick", "staggered"],
    maxLayers: 2,
    targetCenterOfMassXmm: 0,
    toleranceStack: [
      {
        id: "nickel",
        label: "Nickel at terminals",
        kind: "nickel",
        scope: "cell",
        application: "axial-ends",
        thicknessMm: 0.2,
      },
      {
        id: "fishpaper",
        label: "Fishpaper around cells",
        kind: "fishpaper",
        scope: "cell",
        application: "radial",
        thicknessMm: 0.2,
      },
      {
        id: "compound",
        label: "Compound / cell gap",
        kind: "compound",
        scope: "cell",
        application: "between-cells",
        thicknessMm: 0.2,
      },
      {
        id: "holder-wall",
        label: "Стенка холдера",
        kind: "holder",
        scope: "cell",
        application: "between-cells",
        thicknessMm: 1.2,
      },
      {
        id: "layer-lift",
        label: "Подъём слоя (staggered)",
        kind: "holder",
        scope: "series-group",
        application: "between-layers",
        thicknessMm: 0,
      },
      {
        id: "holder-floor",
        label: "Дно холдера",
        kind: "holder",
        scope: "pack-block",
        application: "floor",
        thicknessMm: 0,
      },
      {
        id: "group-separator",
        label: "Group separator",
        kind: "fishpaper",
        scope: "series-group",
        application: "between-groups",
        thicknessMm: 1.4,
      },
      {
        id: "outer-wrap",
        label: "Outer wrap",
        kind: "outer-wrap",
        scope: "pack-block",
        application: "all-faces",
        thicknessMm: 1,
      },
    ],
    wiringExitMode: "combined",
    serviceReservations: createDefaultServiceReservations().map((reservation) => ({
      ...reservation,
      enabled: false,
    })),
  },
};

interface PlannerState {
  config: PlannerConfig;
  placements: ComponentPlacement[];
  selectedPlanId?: string;
  /** Lattice signature of the selection: survives plan-id reshuffles. */
  selectedPlanKey?: string;
  selectedComponentId?: string;
  rightPanel: "variants" | "components";
  showHolders: boolean;
  holderStyle: HolderStyle;
  /** File the project was opened from or saved to; undefined for an unsaved project. */
  projectPath?: string;
  setProjectPath: (path: string | undefined) => void;
  /** Replace the working project with a validated file; false if it could not be applied. */
  loadProject: (project: ProjectFile, path: string) => boolean;
  setEnclosureKind: (kind: EnclosureSpec["kind"]) => void;
  setEnclosureAsset: (assetId: string) => void;
  setEnclosureDimension: (key: keyof Dimensions3D, value: number) => void;
  setPackField: <K extends keyof PackRequest>(key: K, value: PackRequest[K]) => void;
  setTolerance: (id: string, thicknessMm: number) => void;
  setService: (id: string, patch: Partial<ServiceReservation>) => void;
  setWiringExitMode: (mode: WiringExitMode) => void;
  setSelectedPlan: (id: string | undefined, key: string | undefined) => void;
  setSelectedComponentId: (id: string | undefined) => void;
  setRightPanel: (panel: "variants" | "components") => void;
  setShowHolders: (show: boolean) => void;
  setHolderStyle: (style: HolderStyle) => void;
  /** Add a component at the suggested spot, or at the tail if none was found. */
  addComponent: (
    spec: ComponentSpec,
    suggestion?: { position: [number, number]; rotationDeg: number },
  ) => void;
  updateComponent: (id: string, patch: Partial<ComponentPlacement>) => void;
  removeComponent: (id: string) => void;
  resetProject: () => void;
}

function freshConfig(): PlannerConfig {
  return structuredClone(defaultConfig);
}

export const usePlannerStore = create<PlannerState>()(
  persist(
    (set) => ({
      config: freshConfig(),
      placements: [],
      rightPanel: "variants",
      showHolders: true,
      holderStyle: "full",
      setProjectPath: (projectPath) => set({ projectPath }),
      loadProject: (project, projectPath) => {
        const config = sanitizePersistedConfig(project.config);
        if (!config) return false;
        set({
          config,
          placements: sanitizePersistedPlacements(project.components) ?? [],
          projectPath,
          selectedPlanId: undefined,
          selectedPlanKey: undefined,
          selectedComponentId: undefined,
          rightPanel: "variants",
        });
        return true;
      },
      setEnclosureKind: (kind) =>
        set((state) => {
          if (state.config.enclosure.kind === kind) return state;
          return {
            config: {
              ...state.config,
              enclosure:
                kind === "mesh-heightmap"
                  ? createSparkCaseEnclosure()
                  : {
                      kind: "box",
                      dimensionsMm: { length: 800, width: 210, height: 34 },
                    },
            },
            placements: [],
            selectedPlanId: undefined,
            selectedPlanKey: undefined,
            selectedComponentId: undefined,
          };
        }),
      setEnclosureAsset: (assetId) =>
        set((state) => {
          if (
            state.config.enclosure.kind === "mesh-heightmap" &&
            state.config.enclosure.assetId === assetId
          ) {
            return state;
          }
          return {
            config: { ...state.config, enclosure: createMeshEnclosure(assetId) },
            placements: [],
            selectedPlanId: undefined,
            selectedPlanKey: undefined,
            selectedComponentId: undefined,
          };
        }),
      setEnclosureDimension: (key, value) =>
        set((state) => ({
          config: {
            ...state.config,
            enclosure: {
              ...state.config.enclosure,
              dimensionsMm: {
                ...state.config.enclosure.dimensionsMm,
                [key]: Math.max(1, value),
              },
            },
          },
        })),
      setPackField: (key, value) =>
        set((state) => ({
          config: { ...state.config, pack: { ...state.config.pack, [key]: value } },
        })),
      setTolerance: (id, thicknessMm) =>
        set((state) => ({
          config: {
            ...state.config,
            pack: {
              ...state.config.pack,
              toleranceStack: state.config.pack.toleranceStack.map((layer) =>
                layer.id === id ? { ...layer, thicknessMm: Math.max(0, thicknessMm) } : layer,
              ),
            },
          },
        })),
      setService: (id, patch) =>
        set((state) => ({
          config: {
            ...state.config,
            pack: {
              ...state.config.pack,
              serviceReservations: state.config.pack.serviceReservations.map((reservation) =>
                reservation.id === id ? { ...reservation, ...patch } : reservation,
              ),
            },
          },
        })),
      setWiringExitMode: (mode) =>
        set((state) => ({
          config: {
            ...state.config,
            pack: updateWiringExitMode(state.config.pack, mode),
          },
        })),
      setSelectedPlan: (selectedPlanId, selectedPlanKey) =>
        set({ selectedPlanId, selectedPlanKey }),
      setShowHolders: (showHolders) => set({ showHolders }),
      setHolderStyle: (holderStyle) => set({ holderStyle }),
      setSelectedComponentId: (selectedComponentId) => set({ selectedComponentId }),
      setRightPanel: (rightPanel) => set({ rightPanel }),
      addComponent: (spec, suggestion) =>
        set((state) => {
          const id = `${spec.id}-${placementId()}`;
          const tailX =
            -state.config.enclosure.dimensionsMm.length / 2 + spec.dimensionsMm.length / 2 + 5;
          const spreadY = Math.min(state.placements.length * 12, 50);
          return {
            placements: [
              ...state.placements,
              {
                id,
                componentId: spec.id,
                position: suggestion?.position ?? [tailX, spreadY],
                rotationDeg: suggestion?.rotationDeg ?? 0,
                tiltDeg: 0,
                dimensionsMm: { ...spec.dimensionsMm },
              },
            ],
            selectedComponentId: id,
            rightPanel: "components",
          };
        }),
      updateComponent: (id, patch) =>
        set((state) => ({
          placements: state.placements.map((placement) =>
            placement.id === id ? { ...placement, ...patch } : placement,
          ),
        })),
      removeComponent: (id) =>
        set((state) => ({
          placements: state.placements.filter((placement) => placement.id !== id),
          selectedComponentId:
            state.selectedComponentId === id ? undefined : state.selectedComponentId,
        })),
      resetProject: () =>
        set({
          config: freshConfig(),
          placements: [],
          selectedPlanId: undefined,
          selectedPlanKey: undefined,
          selectedComponentId: undefined,
          rightPanel: "variants",
          projectPath: undefined,
        }),
    }),
    {
      name: "deckpack-spark-project-v2",
      version: 2,
      // Older stored versions are dropped: the layout engine and defaults
      // changed, so a fresh project is safer than a partial migration.
      migrate: () => ({
        config: freshConfig(),
        placements: [] as ComponentPlacement[],
        selectedPlanId: undefined as string | undefined,
        selectedPlanKey: undefined as string | undefined,
        holderStyle: "full" as HolderStyle,
      }),
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<{
          config: unknown;
          placements: unknown;
          selectedPlanId: unknown;
          selectedPlanKey: unknown;
          holderStyle: unknown;
          projectPath: unknown;
        }>;
        const config = sanitizePersistedConfig(stored.config);
        const placements = sanitizePersistedPlacements(stored.placements);
        return {
          ...current,
          config: config ?? freshConfig(),
          placements: config ? (placements ?? []) : [],
          selectedPlanId:
            typeof stored.selectedPlanId === "string" ? stored.selectedPlanId : undefined,
          selectedPlanKey:
            typeof stored.selectedPlanKey === "string" ? stored.selectedPlanKey : undefined,
          holderStyle: stored.holderStyle === "edge" ? "edge" : "full",
          projectPath: typeof stored.projectPath === "string" ? stored.projectPath : undefined,
        };
      },
      partialize: (state) => ({
        config: state.config,
        placements: state.placements,
        selectedPlanId: state.selectedPlanId,
        selectedPlanKey: state.selectedPlanKey,
        holderStyle: state.holderStyle,
        projectPath: state.projectPath,
      }),
    },
  ),
);

/** crypto.randomUUID is unavailable outside secure contexts (e.g. LAN http). */
function placementId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function toleranceById(stack: ToleranceLayer[], id: string) {
  return stack.find((layer) => layer.id === id);
}
