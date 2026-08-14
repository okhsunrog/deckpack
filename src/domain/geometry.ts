import type {
  Box3D,
  ComponentPlacement,
  Dimensions3D,
  EnclosureSpec,
  LargestFreeBox,
  PackPlan,
  Vec3,
  WorkspaceEvaluation,
} from "./types";

const EPSILON = 1e-6;

export interface ContainmentKernel<TSpec> {
  bounds(spec: TSpec): Box3D;
  contains(spec: TSpec, object: Box3D): boolean;
  clearance(spec: TSpec, object: Box3D): number;
  volume(spec: TSpec): number;
}

export const boxContainmentKernel: ContainmentKernel<EnclosureSpec> = {
  bounds: enclosureBounds,
  contains(spec, object) {
    return containsBox(enclosureBounds(spec), object);
  },
  clearance(spec, object) {
    const container = enclosureBounds(spec);
    return Math.min(
      object.min[0] - container.min[0],
      container.max[0] - object.max[0],
      object.min[1] - container.min[1],
      container.max[1] - object.max[1],
      object.min[2] - container.min[2],
      container.max[2] - object.max[2],
    );
  },
  volume(spec) {
    const { length, width, height } = spec.dimensionsMm;
    return length * width * height;
  },
};

export function enclosureBounds(spec: EnclosureSpec): Box3D {
  const { length, width, height } = spec.dimensionsMm;
  return {
    min: [-length / 2, -width / 2, -height / 2],
    max: [length / 2, width / 2, height / 2],
  };
}

export function boxFromCenterSize(center: Vec3, size: Vec3): Box3D {
  return {
    min: [center[0] - size[0] / 2, center[1] - size[1] / 2, center[2] - size[2] / 2],
    max: [center[0] + size[0] / 2, center[1] + size[1] / 2, center[2] + size[2] / 2],
  };
}

export function boxSize(box: Box3D): Vec3 {
  return [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
}

export function boxCenter(box: Box3D): Vec3 {
  return [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];
}

export function boxVolume(box: Box3D): number {
  const size = boxSize(box);
  return Math.max(0, size[0]) * Math.max(0, size[1]) * Math.max(0, size[2]);
}

export function translateBox(box: Box3D, offset: Vec3): Box3D {
  return {
    min: [box.min[0] + offset[0], box.min[1] + offset[1], box.min[2] + offset[2]],
    max: [box.max[0] + offset[0], box.max[1] + offset[1], box.max[2] + offset[2]],
  };
}

export function expandBox(box: Box3D, amount: Vec3): Box3D {
  return {
    min: [box.min[0] - amount[0], box.min[1] - amount[1], box.min[2] - amount[2]],
    max: [box.max[0] + amount[0], box.max[1] + amount[1], box.max[2] + amount[2]],
  };
}

export function unionBoxes(boxes: Box3D[]): Box3D {
  if (boxes.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  const result: Box3D = { min: [...boxes[0].min], max: [...boxes[0].max] };
  for (const box of boxes.slice(1)) {
    for (let axis = 0; axis < 3; axis += 1) {
      result.min[axis] = Math.min(result.min[axis], box.min[axis]);
      result.max[axis] = Math.max(result.max[axis], box.max[axis]);
    }
  }
  return result;
}

export function containsBox(container: Box3D, object: Box3D): boolean {
  return (
    object.min.every((value, axis) => value >= container.min[axis] - EPSILON) &&
    object.max.every((value, axis) => value <= container.max[axis] + EPSILON)
  );
}

export function boxesIntersect(a: Box3D, b: Box3D, clearance = 0): boolean {
  return [0, 1, 2].every(
    (axis) => a.min[axis] < b.max[axis] + clearance && a.max[axis] > b.min[axis] - clearance,
  );
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function largestEmptyAxisAlignedBox(container: Box3D, obstacles: Box3D[]): LargestFreeBox {
  const clipped = obstacles.filter((obstacle) => boxesIntersect(container, obstacle));
  const coordinates = ([0, 1, 2] as const).map((axis) => {
    const values = new Set<number>([container.min[axis], container.max[axis]]);
    for (const obstacle of clipped) {
      values.add(Math.max(container.min[axis], Math.min(container.max[axis], obstacle.min[axis])));
      values.add(Math.max(container.min[axis], Math.min(container.max[axis], obstacle.max[axis])));
    }
    return [...values].sort((a, b) => a - b);
  });

  let best: LargestFreeBox = {
    box: { min: [...container.min], max: [...container.min] },
    volumeMm3: 0,
  };
  for (let x0 = 0; x0 < coordinates[0].length - 1; x0 += 1) {
    for (let x1 = x0 + 1; x1 < coordinates[0].length; x1 += 1) {
      for (let y0 = 0; y0 < coordinates[1].length - 1; y0 += 1) {
        for (let y1 = y0 + 1; y1 < coordinates[1].length; y1 += 1) {
          for (let z0 = 0; z0 < coordinates[2].length - 1; z0 += 1) {
            for (let z1 = z0 + 1; z1 < coordinates[2].length; z1 += 1) {
              const candidate: Box3D = {
                min: [coordinates[0][x0], coordinates[1][y0], coordinates[2][z0]],
                max: [coordinates[0][x1], coordinates[1][y1], coordinates[2][z1]],
              };
              const volume = boxVolume(candidate);
              if (volume <= best.volumeMm3) continue;
              if (clipped.some((obstacle) => boxesIntersect(candidate, obstacle))) continue;
              best = { box: candidate, volumeMm3: volume };
            }
          }
        }
      }
    }
  }
  return best;
}

export function dimensionsToVec3(dimensions: Dimensions3D): Vec3 {
  return [dimensions.length, dimensions.width, dimensions.height];
}

export function componentBox(placement: ComponentPlacement, enclosure: EnclosureSpec): Box3D {
  const rotated = placement.rotationQuarterTurns % 2 !== 0;
  const size: Vec3 = rotated
    ? [placement.dimensionsMm.width, placement.dimensionsMm.length, placement.dimensionsMm.height]
    : dimensionsToVec3(placement.dimensionsMm);
  const z = -enclosure.dimensionsMm.height / 2 + size[2] / 2;
  return boxFromCenterSize([placement.position[0], placement.position[1], z], size);
}

export function evaluateWorkspace(
  enclosure: EnclosureSpec,
  plan: PackPlan,
  components: ComponentPlacement[],
): WorkspaceEvaluation {
  const container = enclosureBounds(enclosure);
  const packObstacles = [
    ...plan.blocks.map((block) => block.envelope),
    ...plan.serviceVolumes.map((v) => v.box),
  ];
  const boxes = components.map((placement) => componentBox(placement, enclosure));
  const evaluated = components.map((component, index) => {
    const box = boxes[index];
    const collidesPack = packObstacles.some((obstacle) => boxesIntersect(box, obstacle));
    const collidesComponent = boxes.some(
      (other, otherIndex) => otherIndex !== index && boxesIntersect(box, other),
    );
    return {
      id: component.id,
      box,
      collides: collidesPack || collidesComponent,
      outside: !containsBox(container, box),
    };
  });
  const allObstacles = [...packObstacles, ...boxes];
  const enclosureVolume = boxVolume(container);
  const occupiedVolume = allObstacles.reduce((sum, box) => sum + boxVolume(box), 0);
  const freeVolumeMm3 = Math.max(0, enclosureVolume - occupiedVolume);
  return {
    components: evaluated,
    hasCollision: evaluated.some((item) => item.collides || item.outside),
    freeVolumeMm3,
    freePercent: (freeVolumeMm3 / enclosureVolume) * 100,
    largestFreeBox: largestEmptyAxisAlignedBox(container, allObstacles),
  };
}
