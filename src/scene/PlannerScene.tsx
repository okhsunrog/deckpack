import { Line, OrbitControls, RoundedBox, Text, TransformControls } from "@react-three/drei";
import { Canvas, type ThreeEvent, useLoader, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
} from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { boxCenter, boxSize, componentBox } from "../domain/geometry";
import type {
  ComponentPlacement,
  ComponentSpec,
  ComponentVisual,
  Dimensions3D,
  EnclosureSpec,
  PackPlan,
  ServiceReservation,
  ServiceVolume,
  Vec3,
  WorkspaceEvaluation,
} from "../domain/types";

interface PlannerSceneProps {
  enclosure: EnclosureSpec;
  plan?: PackPlan;
  components: ComponentPlacement[];
  componentSpecs: ComponentSpec[];
  evaluation?: WorkspaceEvaluation;
  selectedComponentId?: string;
  onSelectComponent: (id: string | undefined) => void;
  onMoveComponent: (id: string, position: [number, number]) => void;
  onRemoveComponent: (id: string) => void;
  serviceReservations: ServiceReservation[];
  onUpdateService: (id: string, patch: Partial<ServiceReservation>) => void;
}

type KeepOutTool = "translate" | "scale";

const CELL_COLORS = ["#d59b45", "#d36d4b", "#809ba2", "#7e927a", "#a77ca0", "#718aaf"];

interface ComponentVisualProps {
  dimensions: Dimensions3D;
  color: string;
}

function PlainCase({ dimensions, color }: ComponentVisualProps) {
  const { length, width, height } = dimensions;
  return (
    <RoundedBox args={[length, width, height]} radius={Math.min(2.2, height * 0.16)} smoothness={3}>
      <meshStandardMaterial color={color} roughness={0.36} metalness={0.5} />
    </RoundedBox>
  );
}

function TopTextureCase({
  dimensions,
  color,
  visual,
}: ComponentVisualProps & {
  visual: Extract<ComponentVisual, { kind: "top-texture" }>;
}) {
  const texture = useLoader(TextureLoader, visual.assetUrl);
  const { length, width, height } = dimensions;
  const inset = Math.min(visual.insetMm ?? 1, length / 4, width / 4);

  useLayoutEffect(() => {
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
  }, [texture]);

  return (
    <group>
      <PlainCase dimensions={dimensions} color={color} />
      <mesh position={[0, 0, height / 2 + 0.08]}>
        <planeGeometry args={[length - inset * 2, width - inset * 2]} />
        <meshStandardMaterial map={texture} transparent roughness={0.5} metalness={0.05} />
      </mesh>
    </group>
  );
}

function StlCase({
  dimensions,
  color,
  visual,
}: ComponentVisualProps & { visual: Extract<ComponentVisual, { kind: "stl" }> }) {
  const sourceGeometry = useLoader(STLLoader, visual.assetUrl);
  const prepared = useMemo(() => {
    const geometry = sourceGeometry.clone();
    const rotation = visual.rotationDeg ?? [0, 0, 0];
    geometry.rotateX((rotation[0] * Math.PI) / 180);
    geometry.rotateY((rotation[1] * Math.PI) / 180);
    geometry.rotateZ((rotation[2] * Math.PI) / 180);
    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;
    if (!bounds) return { geometry, scale: [1, 1, 1] as Vec3 };
    const sourceSize = bounds.getSize(new Vector3());
    const center = bounds.getCenter(new Vector3());
    geometry.translate(-center.x, -center.y, -center.z);
    geometry.computeVertexNormals();
    return {
      geometry,
      scale: [
        dimensions.length / Math.max(sourceSize.x, 0.001),
        dimensions.width / Math.max(sourceSize.y, 0.001),
        dimensions.height / Math.max(sourceSize.z, 0.001),
      ] as Vec3,
    };
  }, [dimensions.height, dimensions.length, dimensions.width, sourceGeometry, visual.rotationDeg]);

  return (
    <mesh geometry={prepared.geometry} scale={prepared.scale} castShadow receiveShadow>
      <meshStandardMaterial color={color} roughness={0.32} metalness={0.58} />
    </mesh>
  );
}

function ProceduralCase({
  dimensions,
  color,
  style,
}: ComponentVisualProps & {
  style: Extract<ComponentVisual, { kind: "procedural" }>["style"];
}) {
  const { length, width, height } = dimensions;
  const finCount = Math.max(4, Math.min(10, Math.round(length / 13)));
  const fins = Array.from({ length: finCount }, (_, index) => {
    const x = ((index + 1) / (finCount + 1) - 0.5) * length * 0.78;
    return (
      <mesh key={x} position={[x, 0, height / 2 + 0.75]} castShadow>
        <boxGeometry args={[1.25, width * 0.72, 1.5]} />
        <meshStandardMaterial color="#c6ced0" roughness={0.3} metalness={0.72} />
      </mesh>
    );
  });
  const screwPositions = [
    [-length * 0.39, -width * 0.36],
    [-length * 0.39, width * 0.36],
    [length * 0.39, -width * 0.36],
    [length * 0.39, width * 0.36],
  ] as const;

  return (
    <group>
      <PlainCase dimensions={dimensions} color={color} />
      {style === "finned-case" && fins}
      {style === "sealed-case" &&
        screwPositions.map(([x, y]) => (
          <mesh
            key={`${x}-${y}`}
            position={[x, y, height / 2 + 0.45]}
            rotation={[Math.PI / 2, 0, 0]}
          >
            <cylinderGeometry args={[1.5, 1.5, 0.9, 16]} />
            <meshStandardMaterial color="#20272a" roughness={0.42} metalness={0.75} />
          </mesh>
        ))}
      {style === "pcb" && (
        <>
          <mesh position={[0, 0, height / 2 + 0.12]}>
            <boxGeometry args={[length * 0.91, width * 0.9, 0.5]} />
            <meshStandardMaterial color="#1e625f" roughness={0.52} metalness={0.18} />
          </mesh>
          {[-0.28, 0, 0.28].map((offset) => (
            <mesh key={offset} position={[length * offset, 0, height / 2 + 1.1]}>
              <boxGeometry args={[length * 0.12, width * 0.42, 1.8]} />
              <meshStandardMaterial color="#20272a" roughness={0.38} metalness={0.52} />
            </mesh>
          ))}
        </>
      )}
    </group>
  );
}

function ComponentVisualObject({ spec }: { spec: ComponentSpec }) {
  const visual = spec.visual;
  if (!visual) return <PlainCase dimensions={spec.dimensionsMm} color={spec.color} />;
  if (visual.kind === "top-texture") {
    return <TopTextureCase dimensions={spec.dimensionsMm} color={spec.color} visual={visual} />;
  }
  if (visual.kind === "stl") {
    return <StlCase dimensions={spec.dimensionsMm} color={spec.color} visual={visual} />;
  }
  return <ProceduralCase dimensions={spec.dimensionsMm} color={spec.color} style={visual.style} />;
}

function orientationQuaternion(orientation: PackPlan["orientation"]): Quaternion {
  const quaternion = new Quaternion();
  if (orientation === "x") quaternion.setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2);
  if (orientation === "z") quaternion.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
  return quaternion;
}

function CellInstances({ plan }: { plan: PackPlan }) {
  const meshRef = useRef<InstancedMesh>(null);
  const diameter = Math.min(...plan.cellSizeMm);
  const height = Math.max(...plan.cellSizeMm);
  const geometry = useMemo(
    () => new CylinderGeometry(diameter / 2, diameter / 2, height, 20),
    [diameter, height],
  );
  const material = useMemo(
    () => new MeshStandardMaterial({ roughness: 0.48, metalness: 0.16 }),
    [],
  );

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const quaternion = orientationQuaternion(plan.orientation);
    plan.cells.forEach((cell, index) => {
      const matrix = new Matrix4().compose(
        new Vector3(...cell.position),
        quaternion,
        new Vector3(1, 1, 1),
      );
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(index, new Color(CELL_COLORS[cell.seriesIndex % CELL_COLORS.length]));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, plan.cells.length]}
      castShadow
      receiveShadow
    />
  );
}

function BoxObject({
  box,
  color,
  opacity = 0.2,
  wireframe = false,
}: {
  box: { min: Vec3; max: Vec3 };
  color: string;
  opacity?: number;
  wireframe?: boolean;
}) {
  const size = boxSize(box);
  const center = boxCenter(box);
  return (
    <mesh position={center}>
      <boxGeometry args={size} />
      <meshStandardMaterial
        color={color}
        transparent
        opacity={opacity}
        wireframe={wireframe}
        depthWrite={!wireframe}
      />
    </mesh>
  );
}

function KeepOutShape({
  size,
  reservation,
  selected,
  onPointerDown,
}: {
  size: Vec3;
  reservation: ServiceReservation;
  selected: boolean;
  onPointerDown: (event: ThreeEvent<PointerEvent>) => void;
}) {
  const [length, width, height] = size;
  const normalAxis = reservation.face.endsWith("x") ? 0 : 1;
  const tangentAxis = normalAxis === 0 ? 1 : 0;
  const lineLength = Math.max(2, size[normalAxis] - 4);
  const lineOffset = Math.min(4, size[tangentAxis] * 0.18);
  const linePoints = (offset: number): Vec3[] => {
    const start: Vec3 = [0, 0, 0];
    const end: Vec3 = [0, 0, 0];
    start[normalAxis] = -lineLength / 2;
    end[normalAxis] = lineLength / 2;
    start[tangentAxis] = offset;
    end[tangentAxis] = offset;
    return [start, end];
  };
  const showPower = reservation.kind !== "balance-harness";
  const showBalance = reservation.kind !== "power-output";
  const shellColor = reservation.kind === "balance-harness" ? "#58b9c4" : "#d4864d";
  const shortLabel =
    reservation.kind === "wiring-exit"
      ? "PWR + BAL"
      : reservation.kind === "power-output"
        ? "POWER"
        : "BALANCE";
  return (
    <group onPointerDown={onPointerDown}>
      <RoundedBox
        args={[length, width, height]}
        radius={Math.max(0.8, Math.min(3, length / 8, width / 8, height / 4))}
        smoothness={3}
      >
        <meshPhysicalMaterial
          color={shellColor}
          emissive={shellColor}
          emissiveIntensity={selected ? 0.14 : 0.04}
          transparent
          opacity={selected ? 0.28 : 0.15}
          roughness={0.34}
          metalness={0.08}
          transmission={0.08}
          depthWrite={false}
        />
      </RoundedBox>
      {showPower && (
        <Line
          points={linePoints(showBalance ? -lineOffset : 0)}
          color="#ff8954"
          lineWidth={selected ? 4 : 3}
          transparent
          opacity={0.94}
        />
      )}
      {showBalance && (
        <Line
          points={linePoints(showPower ? lineOffset : 0)}
          color="#72d4dc"
          lineWidth={selected ? 2.4 : 1.8}
          transparent
          opacity={0.94}
        />
      )}
      <Text
        position={[0, 0, height / 2 + 1.6]}
        fontSize={Math.max(2.4, Math.min(4, width * 0.12))}
        color={selected ? "#f6e1c6" : "#b9c4c7"}
        anchorX="center"
        anchorY="bottom"
      >
        {shortLabel}
      </Text>
    </group>
  );
}

function EditableKeepOut({
  volume,
  reservation,
  selected,
  tool,
  onSelect,
  onCommit,
}: {
  volume: ServiceVolume;
  reservation: ServiceReservation;
  selected: boolean;
  tool: KeepOutTool;
  onSelect: () => void;
  onCommit: (patch: Partial<ServiceReservation>) => void;
}) {
  const objectRef = useRef<Group>(null!);
  const size = boxSize(volume.box);
  const center = boxCenter(volume.box);

  const commitTransform = () => {
    const object = objectRef.current;
    if (!object) return;
    const nextSize = size.map((value, axis) =>
      Math.max(1, Math.round(value * Math.abs(object.scale.getComponent(axis)) * 10) / 10),
    ) as Vec3;
    const currentOffset = reservation.offsetMm ?? [0, 0, 0];
    const baseCenter = center.map((value, axis) => value - currentOffset[axis]) as Vec3;
    const faceAxis = reservation.face.endsWith("x") ? 0 : 1;
    const direction = reservation.face.startsWith("positive") ? 1 : -1;
    baseCenter[faceAxis] += (direction * (nextSize[faceAxis] - size[faceAxis])) / 2;
    const nextOffset = baseCenter.map(
      (value, axis) => Math.round((object.position.getComponent(axis) - value) * 10) / 10,
    ) as Vec3;
    object.scale.set(1, 1, 1);
    onCommit({ sizeMm: nextSize, offsetMm: nextOffset });
  };

  const shape = (
    <group ref={objectRef} position={center}>
      <KeepOutShape
        size={size}
        reservation={reservation}
        selected={selected}
        onPointerDown={(event) => {
          event.stopPropagation();
          onSelect();
        }}
      />
    </group>
  );

  if (!selected) return shape;
  return (
    <TransformControls
      object={objectRef}
      mode={tool}
      space="world"
      size={0.72}
      translationSnap={1}
      scaleSnap={0.05}
      onMouseUp={commitTransform}
    >
      {shape}
    </TransformControls>
  );
}

function EnclosureObject({ enclosure }: { enclosure: EnclosureSpec }) {
  const { length, width, height } = enclosure.dimensionsMm;
  return (
    <group>
      <mesh>
        <boxGeometry args={[length, width, height]} />
        <meshPhysicalMaterial
          color="#60727d"
          transparent
          opacity={0.075}
          roughness={0.28}
          transmission={0.1}
          depthWrite={false}
        />
      </mesh>
      <lineSegments>
        <edgesGeometry args={[new BoxGeometry(length, width, height)]} />
        <lineBasicMaterial color="#79909c" transparent opacity={0.62} />
      </lineSegments>
    </group>
  );
}

function ComponentObjects({
  enclosure,
  components,
  specs,
  evaluation,
  selectedId,
  onPointerDown,
  onContextMenu,
}: {
  enclosure: EnclosureSpec;
  components: ComponentPlacement[];
  specs: ComponentSpec[];
  evaluation?: WorkspaceEvaluation;
  selectedId?: string;
  onPointerDown: (event: ThreeEvent<PointerEvent>, id: string) => void;
  onContextMenu: (event: ThreeEvent<MouseEvent>, id: string) => void;
}) {
  return components.map((component) => {
    const box = componentBox(component, enclosure);
    const size = boxSize(box);
    const center = boxCenter(box);
    const spec = specs.find((candidate) => candidate.id === component.componentId);
    const state = evaluation?.components.find((item) => item.id === component.id);
    const invalid = state?.collides || state?.outside;
    const selected = component.id === selectedId;
    const fallbackSpec: ComponentSpec = {
      id: component.componentId,
      manufacturer: "Custom",
      model: "Component",
      category: "custom",
      dimensionsMm: component.dimensionsMm,
      color: "#839099",
    };
    const renderedSpec = spec ?? fallbackSpec;
    const rotationZ = component.rotationQuarterTurns * (Math.PI / 2);
    return (
      <group key={component.id}>
        <group
          position={center}
          rotation={[0, 0, rotationZ]}
          onPointerDown={(event) => onPointerDown(event, component.id)}
          onContextMenu={(event) => onContextMenu(event, component.id)}
        >
          <Suspense
            fallback={
              <PlainCase dimensions={renderedSpec.dimensionsMm} color={renderedSpec.color} />
            }
          >
            <ComponentVisualObject spec={renderedSpec} />
          </Suspense>
          {invalid && (
            <RoundedBox
              args={[
                renderedSpec.dimensionsMm.length + 1,
                renderedSpec.dimensionsMm.width + 1,
                renderedSpec.dimensionsMm.height + 1,
              ]}
              radius={2}
              smoothness={2}
            >
              <meshBasicMaterial color="#ff3f52" transparent opacity={0.44} depthWrite={false} />
            </RoundedBox>
          )}
        </group>
        {selected && (
          <lineSegments position={center}>
            <edgesGeometry args={[new BoxGeometry(size[0] + 3, size[1] + 3, size[2] + 3)]} />
            <lineBasicMaterial color="#f5c36b" />
          </lineSegments>
        )}
        <Text
          position={[center[0], center[1], box.max[2] + 3]}
          fontSize={5.5}
          color="#e8eef0"
          anchorX="center"
          anchorY="bottom"
          rotation={[0, 0, 0]}
        >
          {spec?.model ?? "Component"}
        </Text>
      </group>
    );
  });
}

function CameraSetup({ enclosure }: { enclosure: EnclosureSpec }) {
  const { camera } = useThree();
  useLayoutEffect(() => {
    camera.up.set(0, 0, 1);
    const length = enclosure.dimensionsMm.length;
    camera.position.set(length * 0.52, -length * 0.62, length * 0.48);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera, enclosure.dimensionsMm.length]);
  return null;
}

interface SceneContentsProps extends PlannerSceneProps {
  selectedKeepOutId?: string;
  keepOutTool: KeepOutTool;
  onSelectKeepOut: (id: string | undefined) => void;
  onOpenComponentMenu: (id: string, position: [number, number]) => void;
  onCloseComponentMenu: () => void;
}

function SceneContents(props: SceneContentsProps) {
  const [dragging, setDragging] = useState<{ id: string; offset: [number, number] }>();
  const { enclosure, plan } = props;
  const floorZ = -enclosure.dimensionsMm.height / 2 + 0.01;
  const startDrag = (event: ThreeEvent<PointerEvent>, id: string) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    const placement = props.components.find((component) => component.id === id);
    if (!placement) return;
    props.onCloseComponentMenu();
    props.onSelectKeepOut(undefined);
    props.onSelectComponent(id);
    setDragging({
      id,
      offset: [placement.position[0] - event.point.x, placement.position[1] - event.point.y],
    });
  };
  const openComponentMenu = (event: ThreeEvent<MouseEvent>, id: string) => {
    event.stopPropagation();
    event.nativeEvent.preventDefault();
    const nativeEvent = event.nativeEvent;
    const canvas = nativeEvent.target as HTMLCanvasElement;
    const bounds = canvas.getBoundingClientRect();
    const x = Math.max(8, Math.min(bounds.width - 188, nativeEvent.clientX - bounds.left));
    const y = Math.max(8, Math.min(bounds.height - 94, nativeEvent.clientY - bounds.top));
    props.onSelectKeepOut(undefined);
    props.onSelectComponent(id);
    props.onOpenComponentMenu(id, [x, y]);
  };
  const moveDrag = (event: ThreeEvent<PointerEvent>) => {
    if (!dragging) return;
    event.stopPropagation();
    const snap = 1;
    const lengthHalf = enclosure.dimensionsMm.length / 2;
    const widthHalf = enclosure.dimensionsMm.width / 2;
    const x =
      Math.round(
        Math.max(-lengthHalf, Math.min(lengthHalf, event.point.x + dragging.offset[0])) / snap,
      ) * snap;
    const y =
      Math.round(
        Math.max(-widthHalf, Math.min(widthHalf, event.point.y + dragging.offset[1])) / snap,
      ) * snap;
    props.onMoveComponent(dragging.id, [x, y]);
  };

  return (
    <>
      <CameraSetup enclosure={enclosure} />
      <color attach="background" args={["#0b141a"]} />
      <hemisphereLight args={["#dcecf2", "#1a252b", 1.8]} />
      <ambientLight intensity={1.25} />
      <directionalLight
        position={[160, -180, 360]}
        intensity={2.6}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-enclosure.dimensionsMm.length * 0.7}
        shadow-camera-right={enclosure.dimensionsMm.length * 0.7}
        shadow-camera-top={enclosure.dimensionsMm.width}
        shadow-camera-bottom={-enclosure.dimensionsMm.width}
        shadow-camera-near={10}
        shadow-camera-far={1000}
        shadow-bias={-0.00015}
      />
      <EnclosureObject enclosure={enclosure} />
      {plan && (
        <>
          <BoxObject box={plan.blocks[0].envelope} color="#d99a46" opacity={0.06} />
          <CellInstances plan={plan} />
          {plan.serviceVolumes.map((volume) => {
            const reservation = props.serviceReservations.find((item) => item.id === volume.id);
            if (!reservation) return null;
            return (
              <EditableKeepOut
                key={volume.id}
                volume={volume}
                reservation={reservation}
                selected={volume.id === props.selectedKeepOutId}
                tool={props.keepOutTool}
                onSelect={() => {
                  props.onSelectComponent(undefined);
                  props.onSelectKeepOut(volume.id);
                }}
                onCommit={(patch) => props.onUpdateService(volume.id, patch)}
              />
            );
          })}
          {plan.seriesPath.length > 1 && (
            <Line
              points={plan.seriesPath}
              color="#f07845"
              lineWidth={2.2}
              transparent
              opacity={0.95}
            />
          )}
        </>
      )}
      <ComponentObjects
        enclosure={enclosure}
        components={props.components}
        specs={props.componentSpecs}
        evaluation={props.evaluation}
        selectedId={props.selectedComponentId}
        onPointerDown={startDrag}
        onContextMenu={openComponentMenu}
      />
      <mesh
        position={[0, 0, floorZ]}
        onPointerMove={moveDrag}
        onPointerUp={() => setDragging(undefined)}
        onPointerLeave={() => setDragging(undefined)}
        onPointerMissed={() => {
          props.onSelectComponent(undefined);
          props.onSelectKeepOut(undefined);
          props.onCloseComponentMenu();
        }}
      >
        <planeGeometry
          args={[enclosure.dimensionsMm.length * 1.3, enclosure.dimensionsMm.width * 1.8]}
        />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <gridHelper
        args={[enclosure.dimensionsMm.length * 1.25, 24, "#314650", "#1c2b33"]}
        rotation={[Math.PI / 2, 0, 0]}
        position={[0, 0, floorZ - 0.2]}
      />
      <OrbitControls
        makeDefault
        enabled={!dragging}
        target={[0, 0, 0]}
        minDistance={120}
        maxDistance={2200}
        maxPolarAngle={Math.PI * 0.49}
      />
    </>
  );
}

export function PlannerScene(props: PlannerSceneProps) {
  const [selectedKeepOutId, setSelectedKeepOutId] = useState<string>();
  const [keepOutTool, setKeepOutTool] = useState<KeepOutTool>("translate");
  const componentMenuRef = useRef<HTMLDivElement>(null);
  const [componentMenu, setComponentMenu] = useState<{
    id: string;
    position: [number, number];
  }>();
  const selectedReservation = props.serviceReservations.find(
    (reservation) => reservation.id === selectedKeepOutId && reservation.enabled,
  );
  const menuComponent = componentMenu
    ? props.components.find((component) => component.id === componentMenu.id)
    : undefined;
  const menuSpec = menuComponent
    ? props.componentSpecs.find((spec) => spec.id === menuComponent.componentId)
    : undefined;

  useEffect(() => {
    if (componentMenu && (!menuComponent || props.selectedComponentId !== componentMenu.id)) {
      setComponentMenu(undefined);
    }
  }, [componentMenu, menuComponent, props.selectedComponentId]);

  useEffect(() => {
    if (!componentMenu) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (componentMenuRef.current?.contains(event.target as Node)) return;
      setComponentMenu(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setComponentMenu(undefined);
    };
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [componentMenu]);

  return (
    <>
      <Canvas
        shadows
        dpr={[1, 1.75]}
        camera={{ fov: 35, near: 1, far: 4500 }}
        gl={{ antialias: true, alpha: false }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <SceneContents
          {...props}
          selectedKeepOutId={selectedKeepOutId}
          keepOutTool={keepOutTool}
          onSelectKeepOut={setSelectedKeepOutId}
          onOpenComponentMenu={(id, position) => setComponentMenu({ id, position })}
          onCloseComponentMenu={() => setComponentMenu(undefined)}
        />
      </Canvas>
      {componentMenu && menuComponent && (
        <div
          ref={componentMenuRef}
          className="component-context-menu"
          role="menu"
          aria-label={`Действия с ${menuSpec?.model ?? "объектом"}`}
          style={{ left: componentMenu.position[0], top: componentMenu.position[1] }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <span>ВЫБРАН ОБЪЕКТ</span>
          <b>{menuSpec?.model ?? "Компонент"}</b>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              props.onRemoveComponent(componentMenu.id);
              setComponentMenu(undefined);
            }}
          >
            <i aria-hidden="true">×</i>
            Удалить объект
            <kbd>Del</kbd>
          </button>
        </div>
      )}
      {selectedReservation && (
        <div className="keepout-editor" role="toolbar" aria-label="Редактирование keep-out">
          <div>
            <span>KEEP-OUT</span>
            <b>{selectedReservation.label}</b>
          </div>
          <button
            type="button"
            aria-pressed={keepOutTool === "translate"}
            className={keepOutTool === "translate" ? "active" : ""}
            onClick={() => setKeepOutTool("translate")}
          >
            Двигать
          </button>
          <button
            type="button"
            aria-pressed={keepOutTool === "scale"}
            className={keepOutTool === "scale" ? "active" : ""}
            onClick={() => setKeepOutTool("scale")}
          >
            Размер
          </button>
          <button
            type="button"
            className="reset-position"
            onClick={() => props.onUpdateService(selectedReservation.id, { offsetMm: [0, 0, 0] })}
          >
            К грани
          </button>
        </div>
      )}
    </>
  );
}
