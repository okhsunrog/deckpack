import type { Box3D, ComponentPlacement, EnclosureSpec } from "../bindings";

type Vec3 = [number, number, number];

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

/**
 * Display-only estimate of a component's box before the Rust evaluation of
 * the current frame arrives: the rotated footprint's bounding rectangle,
 * resting on the nominal (flat) floor of the enclosure. The settled box from
 * `evaluate_workspace` replaces it as soon as it is available.
 */
export function nominalComponentBox(
  placement: ComponentPlacement,
  enclosure: EnclosureSpec,
): Box3D {
  const { length, width, height } = placement.dimensionsMm;
  const tilt = (placement.tiltDeg * Math.PI) / 180;
  const yaw = (placement.rotationDeg * Math.PI) / 180;
  const halfLength =
    (length / 2) * Math.abs(Math.cos(tilt)) + (height / 2) * Math.abs(Math.sin(tilt));
  const halfWidth = width / 2;
  const reachX = Math.abs(Math.cos(yaw)) * halfLength + Math.abs(Math.sin(yaw)) * halfWidth;
  const reachY = Math.abs(Math.sin(yaw)) * halfLength + Math.abs(Math.cos(yaw)) * halfWidth;
  const halfHeight =
    (length / 2) * Math.abs(Math.sin(tilt)) + (height / 2) * Math.abs(Math.cos(tilt));
  const centerZ = -enclosure.dimensionsMm.height / 2 + halfHeight;
  const [x, y] = placement.position;
  return {
    min: [x - reachX, y - reachY, centerZ - halfHeight],
    max: [x + reachX, y + reachY, centerZ + halfHeight],
  };
}
