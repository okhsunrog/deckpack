/**
 * Snapshot the TypeScript domain as golden fixtures for the Rust port.
 *
 * Every fixture stores the exact request and the exact response of one domain
 * entry point so `deckpack-core` can prove parity before the TypeScript
 * implementation is removed. Run with `vp run fixtures`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { componentsLibrary, getCell } from "../src/data/library";
import { evaluateWorkspace } from "../src/domain/geometry";
import {
  computeHolderPieces,
  DEFAULT_HOLDER_OPTIONS,
  generateHolder,
  type HolderOptions,
} from "../src/domain/holder";
import { enumeratePackPlans } from "../src/domain/packing";
import { setWiringExitMode } from "../src/domain/service-reservations";
import { defaultConfig } from "../src/store/planner-store";
import type {
  ComponentPlacement,
  EnumerationRequest,
  EnumerationResponse,
  PackPlan,
  PlannerConfig,
} from "../src/domain/types";

const ROOT = join(import.meta.dirname, "..", "fixtures", "domain");

function clone<T>(value: T): T {
  return structuredClone(value);
}

function write(dir: string, name: string, payload: unknown): void {
  mkdirSync(join(ROOT, dir), { recursive: true });
  writeFileSync(join(ROOT, dir, `${name}.json`), JSON.stringify(payload));
}

/* ---------------------------------------------------------------- configs */

type Mutator = (config: PlannerConfig) => PlannerConfig | void;

function variant(name: string, mutate: Mutator): [string, PlannerConfig] {
  const config = clone(defaultConfig);
  return [name, mutate(config) ?? config];
}

function boxEnclosure(length: number, width: number, height: number): Mutator {
  return (config) => {
    config.enclosure = { kind: "box", dimensionsMm: { length, width, height } };
  };
}

function enableServices(config: PlannerConfig): void {
  config.pack.serviceReservations.forEach((reservation) => {
    reservation.enabled = true;
  });
}

const configs: Array<[string, PlannerConfig]> = [
  variant("spark-12s3p-default", () => {}),
  variant("spark-12s3p-one-layer", (c) => {
    c.pack.maxLayers = 1;
  }),
  variant("spark-12s4p", (c) => {
    c.pack.parallelCount = 4;
  }),
  variant("spark-10s4p", (c) => {
    c.pack.seriesCount = 10;
    c.pack.parallelCount = 4;
  }),
  variant("spark-6s2p", (c) => {
    c.pack.seriesCount = 6;
    c.pack.parallelCount = 2;
  }),
  variant("spark-14s5p", (c) => {
    c.pack.seriesCount = 14;
    c.pack.parallelCount = 5;
  }),
  variant("spark-12s3p-p42a", (c) => {
    c.pack.cellId = "molicel-p42a";
  }),
  variant("spark-12s3p-p45b-three-layers", (c) => {
    c.pack.cellId = "molicel-p45b";
    c.pack.maxLayers = 3;
  }),
  variant("spark-12s3p-orientation-x", (c) => {
    c.pack.orientation = "x";
  }),
  variant("spark-12s3p-orientation-y", (c) => {
    c.pack.orientation = "y";
  }),
  variant("spark-12s3p-orientation-z", (c) => {
    c.pack.orientation = "z";
  }),
  variant("spark-12s3p-brick-only", (c) => {
    c.pack.packingModes = ["brick"];
  }),
  variant("spark-12s3p-staggered-only", (c) => {
    c.pack.packingModes = ["staggered"];
  }),
  variant("spark-12s3p-services-combined", enableServices),
  variant("spark-12s3p-services-separate", (c) => {
    enableServices(c);
    c.pack = setWiringExitMode(c.pack, "separate");
  }),
  variant("spark-12s3p-services-nose", (c) => {
    enableServices(c);
    c.pack.serviceReservations.forEach((reservation) => {
      reservation.face = "positive-x";
    });
  }),
  variant("spark-12s3p-services-side", (c) => {
    enableServices(c);
    c.pack.serviceReservations.forEach((reservation) => {
      reservation.face = "negative-y";
    });
  }),
  variant("spark-12s3p-thin-holder", (c) => {
    for (const layer of c.pack.toleranceStack) {
      if (layer.id === "holder-wall") layer.thicknessMm = 0;
      if (layer.id === "outer-wrap") layer.thicknessMm = 0;
    }
  }),
  variant("spark-12s3p-layer-lift", (c) => {
    for (const layer of c.pack.toleranceStack) {
      if (layer.id === "layer-lift") layer.thicknessMm = 2;
    }
  }),
  variant("spark-12s3p-target-com-nose", (c) => {
    c.pack.targetCenterOfMassXmm = 60;
  }),
  variant("box-800x210x34-12s4p", (c) => {
    boxEnclosure(800, 210, 34)(c);
    c.pack.parallelCount = 4;
    c.pack.serviceReservations.forEach((reservation) => {
      reservation.enabled = reservation.kind === "wiring-exit";
    });
  }),
  variant("box-800x210x60-12s4p", (c) => {
    boxEnclosure(800, 210, 60)(c);
    c.pack.parallelCount = 4;
  }),
  variant("box-300x200x80-12s3p", boxEnclosure(300, 200, 80)),
  variant("box-500x150x50-10s3p-z", (c) => {
    boxEnclosure(500, 150, 50)(c);
    c.pack.seriesCount = 10;
    c.pack.orientation = "z";
    c.pack.maxLayers = 1;
  }),
  variant("box-too-small-12s3p", boxEnclosure(200, 100, 30)),
];

/* -------------------------------------------------------------- enumerate */

rmSync(ROOT, { recursive: true, force: true });

const responses = new Map<string, { request: EnumerationRequest; response: EnumerationResponse }>();
for (const [name, config] of configs) {
  const request: EnumerationRequest = { config, cell: getCell(config.pack.cellId) };
  const response = enumeratePackPlans(request);
  responses.set(name, { request, response });
  write("enumerate", name, { name, request, response });
  console.log(
    `enumerate/${name}: ${response.plans.length} plans, ${response.exploredCount} explored`,
  );
}

/* --------------------------------------------------------------- evaluate */

function component(id: string): ComponentPlacement["dimensionsMm"] {
  const spec = componentsLibrary.find((candidate) => candidate.id === id);
  if (!spec) throw new Error(`Unknown component ${id}`);
  return { ...spec.dimensionsMm };
}

function placement(
  id: string,
  componentId: string,
  position: [number, number],
  rotationDeg = 0,
  tiltDeg = 0,
): ComponentPlacement {
  return { id, componentId, position, rotationDeg, tiltDeg, dimensionsMm: component(componentId) };
}

const componentIds = componentsLibrary.map((spec) => spec.id);
const [escId, bmsId = escId, thirdId = escId] = componentIds;

function pickPlan(name: string, predicate: (plan: PackPlan) => boolean = () => true): PackPlan {
  const plan = responses.get(name)!.response.plans.find(predicate);
  if (!plan) throw new Error(`No plan for ${name}`);
  return plan;
}

const evaluations: Array<{
  name: string;
  configName: string;
  plan: (plans: PackPlan[]) => PackPlan | undefined;
  placements: ComponentPlacement[];
}> = [
  {
    name: "spark-empty",
    configName: "spark-12s3p-default",
    plan: (plans) => plans[0],
    placements: [],
  },
  {
    name: "spark-esc-bms-free",
    configName: "spark-12s3p-default",
    plan: (plans) => plans[0],
    placements: [placement("esc", escId, [120, 0]), placement("bms", bmsId, [-120, 30])],
  },
  {
    name: "spark-rotated-tilted",
    configName: "spark-12s3p-default",
    plan: (plans) => plans[0],
    placements: [
      placement("esc", escId, [110, 10], 30),
      placement("bms", bmsId, [-110, -20], 90, 12),
      placement("third", thirdId, [0, -80], 15, -8),
    ],
  },
  {
    name: "spark-colliding-with-pack",
    configName: "spark-12s3p-default",
    plan: (plans) => plans[0],
    placements: [placement("esc", escId, [0, 0]), placement("bms", bmsId, [0, 0], 45)],
  },
  {
    name: "spark-outside",
    configName: "spark-12s3p-default",
    plan: (plans) => plans[0],
    placements: [placement("esc", escId, [190, 0]), placement("bms", bmsId, [0, 120])],
  },
  {
    name: "spark-staggered-plan",
    configName: "spark-12s3p-default",
    plan: (plans) => plans.find((plan) => plan.packingMode === "staggered"),
    placements: [placement("esc", escId, [125, 0], 90)],
  },
  {
    name: "box-tall-components",
    configName: "box-800x210x60-12s4p",
    plan: (plans) => plans[0],
    placements: [
      placement("esc", escId, [300, 0]),
      placement("bms", bmsId, [-300, 40], 20),
      placement("third", thirdId, [-300, -40], 0, 20),
    ],
  },
];

for (const item of evaluations) {
  const { request, response } = responses.get(item.configName)!;
  const plan = item.plan(response.plans);
  if (!plan) {
    console.log(`evaluate/${item.name}: skipped, no plan`);
    continue;
  }
  const result = evaluateWorkspace(request.config.enclosure, plan, item.placements);
  write("evaluate", item.name, {
    name: item.name,
    enclosure: request.config.enclosure,
    plan,
    placements: item.placements,
    result,
  });
  console.log(`evaluate/${item.name}: collision=${result.hasCollision}`);
}

/* ----------------------------------------------------------------- holder */

const holders: Array<{
  name: string;
  configName: string;
  predicate: (plan: PackPlan) => boolean;
  options: HolderOptions;
}> = [
  {
    name: "spark-staggered-two-layers-full",
    configName: "spark-12s3p-default",
    predicate: (plan) => plan.packingMode === "staggered" && plan.metrics.layerCount === 2,
    options: DEFAULT_HOLDER_OPTIONS,
  },
  {
    name: "spark-staggered-two-layers-edge",
    configName: "spark-12s3p-default",
    predicate: (plan) => plan.packingMode === "staggered" && plan.metrics.layerCount === 2,
    options: { ...DEFAULT_HOLDER_OPTIONS, style: "edge" },
  },
  {
    name: "spark-brick-full",
    configName: "spark-12s3p-default",
    predicate: (plan) => plan.packingMode === "brick",
    options: DEFAULT_HOLDER_OPTIONS,
  },
  {
    name: "box-brick-single-layer",
    configName: "box-800x210x34-12s4p",
    predicate: (plan) => plan.packingMode === "brick" && plan.orientation !== "z",
    options: DEFAULT_HOLDER_OPTIONS,
  },
  {
    name: "box-staggered-coarse",
    configName: "box-800x210x60-12s4p",
    predicate: (plan) => plan.packingMode === "staggered" && plan.orientation !== "z",
    options: {
      ...DEFAULT_HOLDER_OPTIONS,
      sampleStepMm: 0.5,
      clearanceMm: 0.4,
      terminalMarginMm: 5,
    },
  },
];

for (const item of holders) {
  const { request } = responses.get(item.configName)!;
  let plan: PackPlan;
  try {
    plan = pickPlan(item.configName, item.predicate);
  } catch {
    console.log(`holder/${item.name}: skipped, no plan`);
    continue;
  }
  const { config, cell } = request;
  const pieces = computeHolderPieces(
    plan,
    cell,
    config.pack.toleranceStack,
    config.enclosure,
    item.options,
  );
  const build = generateHolder(
    plan,
    cell,
    config.pack.toleranceStack,
    config.enclosure,
    item.options,
  );
  write("holder", item.name, {
    name: item.name,
    plan,
    cell,
    toleranceStack: config.pack.toleranceStack,
    enclosure: config.enclosure,
    options: item.options,
    pieces,
    build: {
      pieces: build.pieces,
      stlByteLength: build.stl.byteLength,
      stlSha256: createHash("sha256").update(new Uint8Array(build.stl)).digest("hex"),
    },
  });
  console.log(`holder/${item.name}: ${build.pieces.length} pieces, ${build.stl.byteLength} bytes`);
}
