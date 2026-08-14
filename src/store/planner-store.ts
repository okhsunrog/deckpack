import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  createDefaultServiceReservations,
  setWiringExitMode as updateWiringExitMode,
} from "../domain/service-reservations";
import type {
  ComponentPlacement,
  ComponentSpec,
  Dimensions3D,
  PackRequest,
  PlannerConfig,
  ServiceReservation,
  ToleranceLayer,
  WiringExitMode,
} from "../domain/types";

export const defaultConfig: PlannerConfig = {
  enclosure: {
    kind: "box",
    dimensionsMm: { length: 800, width: 210, height: 34 },
  },
  pack: {
    seriesCount: 12,
    parallelCount: 4,
    cellId: "molicel-p42a",
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
        thicknessMm: 0.8,
      },
      {
        id: "group-separator",
        label: "Group separator",
        kind: "fishpaper",
        scope: "series-group",
        application: "between-groups",
        thicknessMm: 0.5,
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
    serviceReservations: createDefaultServiceReservations(),
  },
};

interface PlannerState {
  config: PlannerConfig;
  placements: ComponentPlacement[];
  selectedPlanId?: string;
  selectedComponentId?: string;
  rightPanel: "variants" | "components";
  setEnclosureDimension: (key: keyof Dimensions3D, value: number) => void;
  setPackField: <K extends keyof PackRequest>(key: K, value: PackRequest[K]) => void;
  setTolerance: (id: string, thicknessMm: number) => void;
  setService: (id: string, patch: Partial<ServiceReservation>) => void;
  setWiringExitMode: (mode: WiringExitMode) => void;
  setSelectedPlanId: (id: string | undefined) => void;
  setSelectedComponentId: (id: string | undefined) => void;
  setRightPanel: (panel: "variants" | "components") => void;
  addComponent: (spec: ComponentSpec) => void;
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
      setSelectedPlanId: (selectedPlanId) => set({ selectedPlanId }),
      setSelectedComponentId: (selectedComponentId) => set({ selectedComponentId }),
      setRightPanel: (rightPanel) => set({ rightPanel }),
      addComponent: (spec) =>
        set((state) => {
          const id = `${spec.id}-${crypto.randomUUID()}`;
          const tailX =
            -state.config.enclosure.dimensionsMm.length / 2 + spec.dimensionsMm.length / 2 + 5;
          const spreadY = Math.min(state.placements.length * 12, 50);
          return {
            placements: [
              ...state.placements,
              {
                id,
                componentId: spec.id,
                position: [tailX, spreadY],
                rotationQuarterTurns: 0,
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
          selectedComponentId: undefined,
          rightPanel: "variants",
        }),
    }),
    {
      name: "deckpack-project-v1",
      version: 2,
      partialize: (state) => ({
        config: state.config,
        placements: state.placements,
        selectedPlanId: state.selectedPlanId,
      }),
    },
  ),
);

export function toleranceById(stack: ToleranceLayer[], id: string) {
  return stack.find((layer) => layer.id === id);
}
