import { componentsLibrary } from "../data/library";
import {
  commands,
  type ComponentPlacement,
  type ComponentSpec,
  type PackPlan,
  type WorkspaceEvaluation,
} from "../bindings";
import { boxSize } from "../lib/box";
import { formatFactors, planSignature } from "../lib/plan";
import { usePlannerStore } from "../store/planner-store";
import { NumberField } from "./NumberField";

const ANCHOR_LABEL = {
  tail: "хвост",
  center: "центр",
  nose: "нос",
  profile: "по профилю",
} as const;

/** Keep the stored angle in (-180, 180] so the editor stays readable. */
function normalizeAngleDeg(value: number): number {
  const wrapped = ((value % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}
const ORIENTATION_LABEL = { x: "вдоль X", y: "поперёк Y", z: "стоя Z" } as const;

interface ResultsPanelProps {
  plans: PackPlan[];
  exploredCount: number;
  loading: boolean;
  selectedPlan?: PackPlan;
  evaluation?: WorkspaceEvaluation;
}

function VariantCard({
  plan,
  active,
  onSelect,
}: {
  plan: PackPlan;
  active: boolean;
  onSelect: () => void;
}) {
  const size = boxSize(plan.bounds);
  return (
    <button type="button" className={`variant-card ${active ? "active" : ""}`} onClick={onSelect}>
      <span className="variant-score">{plan.metrics.score}</span>
      <span className="variant-main">
        <span className="variant-title">
          <b>{plan.packingMode === "brick" ? "Brick" : "Staggered"}</b>
          {plan.packingMode === "staggered" && <em>кастомный холдер</em>}
        </span>
        <span className="variant-factors">
          P {formatFactors(plan.parallelFactors)} · S {formatFactors(plan.seriesFactors)}
        </span>
        <span className="variant-meta">
          {ORIENTATION_LABEL[plan.orientation]} · {plan.metrics.layerCount} сл. ·{" "}
          {ANCHOR_LABEL[plan.anchor]}
        </span>
        <span className="variant-size">{size.map((value) => value.toFixed(0)).join(" × ")} мм</span>
      </span>
      <span className="variant-chain">Σ {plan.metrics.seriesChainLengthMm.toFixed(0)}</span>
    </button>
  );
}

function PlacementEditor({
  placement,
  evaluation,
}: {
  placement: ComponentPlacement;
  evaluation?: WorkspaceEvaluation;
}) {
  const updateComponent = usePlannerStore((state) => state.updateComponent);
  const removeComponent = usePlannerStore((state) => state.removeComponent);
  const spec = componentsLibrary.find((candidate) => candidate.id === placement.componentId);
  const state = evaluation?.components.find((candidate) => candidate.id === placement.id);
  return (
    <div className="placement-editor">
      <div className="placement-editor-head">
        <div>
          <span>{spec?.manufacturer}</span>
          <h3>{spec?.model}</h3>
        </div>
        <button
          type="button"
          className="delete-component-button"
          onClick={() => removeComponent(placement.id)}
        >
          <span aria-hidden="true">×</span>
          Удалить
          <kbd>Del</kbd>
        </button>
      </div>
      <div className={`placement-state ${state?.outside || state?.collides ? "invalid" : "valid"}`}>
        {state?.outside
          ? "Выходит за корпус"
          : state?.collides
            ? "Обнаружена коллизия"
            : "Позиция свободна"}
      </div>
      <div className="two-column-fields">
        <NumberField
          label="Позиция X"
          value={placement.position[0]}
          step={1}
          unit="мм"
          onChange={(value) =>
            updateComponent(placement.id, { position: [value, placement.position[1]] })
          }
        />
        <NumberField
          label="Позиция Y"
          value={placement.position[1]}
          step={1}
          unit="мм"
          onChange={(value) =>
            updateComponent(placement.id, { position: [placement.position[0], value] })
          }
        />
      </div>
      <div className="dimension-grid component-dimensions">
        {(["length", "width", "height"] as const).map((key) => (
          <NumberField
            key={key}
            label={{ length: "Длина", width: "Ширина", height: "Высота" }[key]}
            value={placement.dimensionsMm[key]}
            min={1}
            unit="мм"
            onChange={(value) =>
              updateComponent(placement.id, {
                dimensionsMm: { ...placement.dimensionsMm, [key]: value },
              })
            }
          />
        ))}
      </div>
      <div className="rotation-controls">
        <NumberField
          label="Поворот"
          value={placement.rotationDeg}
          step={5}
          unit="°"
          onChange={(value) =>
            updateComponent(placement.id, { rotationDeg: normalizeAngleDeg(value) })
          }
        />
        <NumberField
          label="Наклон"
          value={placement.tiltDeg}
          min={-75}
          max={75}
          step={1}
          unit="°"
          onChange={(value) =>
            updateComponent(placement.id, { tiltDeg: Math.max(-75, Math.min(75, value)) })
          }
        />
        <button
          type="button"
          className="rotate-button"
          onClick={() =>
            updateComponent(placement.id, {
              rotationDeg: normalizeAngleDeg(placement.rotationDeg + 90),
            })
          }
        >
          ↻ +90°
        </button>
      </div>
      {spec?.source && <p className="source-note">{spec.source.dimensionBasis}</p>}
      {spec?.visual && spec.visual.kind !== "procedural" && (
        <p className="visual-credit">
          Визуал:{" "}
          <a href={spec.visual.source.url} target="_blank" rel="noreferrer">
            {spec.visual.source.creator}
          </a>{" "}
          ·{" "}
          <a href={spec.visual.source.licenseUrl} target="_blank" rel="noreferrer">
            {spec.visual.source.license}
          </a>
        </p>
      )}
    </div>
  );
}

export function ResultsPanel({
  plans,
  exploredCount,
  loading,
  selectedPlan,
  evaluation,
}: ResultsPanelProps) {
  const selectedPlanId = usePlannerStore((state) => state.selectedPlanId);
  const setSelectedPlan = usePlannerStore((state) => state.setSelectedPlan);
  const placements = usePlannerStore((state) => state.placements);
  const selectedComponentId = usePlannerStore((state) => state.selectedComponentId);
  const setSelectedComponentId = usePlannerStore((state) => state.setSelectedComponentId);
  const rightPanel = usePlannerStore((state) => state.rightPanel);
  const setRightPanel = usePlannerStore((state) => state.setRightPanel);
  const addComponent = usePlannerStore((state) => state.addComponent);
  const enclosure = usePlannerStore((state) => state.config.enclosure);
  const addComponentSmart = async (spec: ComponentSpec) => {
    if (!selectedPlan) {
      addComponent(spec);
      return;
    }
    const result = await commands.suggestPlacement(
      enclosure,
      selectedPlan,
      placements,
      spec.dimensionsMm,
    );
    if (result.status === "error") {
      console.error("Placement suggestion failed", result.error);
      addComponent(spec);
      return;
    }
    if (!result.data) {
      window.alert(`Для ${spec.model} не нашлось свободного места на деке при этой раскладке.`);
      return;
    }
    addComponent(spec, result.data);
  };
  const profiledEnclosure = usePlannerStore(
    (state) => state.config.enclosure.kind === "mesh-heightmap",
  );
  const selectedPlacement = placements.find((placement) => placement.id === selectedComponentId);

  return (
    <aside className="results-panel side-panel">
      <div className="panel-tabs">
        <button
          type="button"
          className={rightPanel === "variants" ? "active" : ""}
          onClick={() => setRightPanel("variants")}
        >
          Варианты <span>{plans.length}</span>
        </button>
        <button
          type="button"
          className={rightPanel === "components" ? "active" : ""}
          onClick={() => setRightPanel("components")}
        >
          Компоненты <span>{placements.length}</span>
        </button>
      </div>

      {rightPanel === "variants" ? (
        <div className="panel-scroll variants-view">
          <div className="results-summary">
            <div>
              <span>Перебрано</span>
              <b>{loading ? "…" : exploredCount.toLocaleString("ru-RU")}</b>
            </div>
            <div>
              <span>Влезает</span>
              <b>{loading ? "…" : plans.length.toLocaleString("ru-RU")}</b>
            </div>
            <p>
              Сортировка: центр массы, длина цепи, зазор
              {profiledEnclosure ? ", точное вхождение в профиль." : ", свободный BOX."}
            </p>
          </div>
          {loading && (
            <div className="loading-rule">
              <span />
            </div>
          )}
          {!loading && plans.length === 0 && (
            <div className="empty-state">
              <strong>Подходящих раскладок нет</strong>
              <p>Увеличьте корпус, число слоёв или уменьшите стек допусков.</p>
            </div>
          )}
          <div className="variant-list">
            {plans.slice(0, 120).map((plan) => (
              <VariantCard
                key={plan.id}
                plan={plan}
                active={plan.id === selectedPlanId}
                onSelect={() => setSelectedPlan(plan.id, planSignature(plan))}
              />
            ))}
          </div>
          {plans.length > 120 && (
            <p className="list-limit">Показаны первые 120 из {plans.length}</p>
          )}
        </div>
      ) : (
        <div className="panel-scroll components-view">
          <div className="collision-summary">
            <span
              className={evaluation?.hasCollision ? "collision-dot invalid" : "collision-dot"}
            />
            <div>
              <b>{evaluation?.hasCollision ? "Есть пересечения" : "Коллизий нет"}</b>
              <span>Перетаскивайте блоки прямо в 3D или задавайте координаты.</span>
            </div>
          </div>

          {placements.length > 0 && (
            <div className="placed-components">
              <span className="subheading">На деке</span>
              {placements.map((placement) => {
                const spec = componentsLibrary.find(
                  (candidate) => candidate.id === placement.componentId,
                );
                const status = evaluation?.components.find(
                  (candidate) => candidate.id === placement.id,
                );
                return (
                  <button
                    type="button"
                    key={placement.id}
                    className={`placed-row ${placement.id === selectedComponentId ? "active" : ""}`}
                    onClick={() => setSelectedComponentId(placement.id)}
                  >
                    <span className="component-swatch" style={{ background: spec?.color }} />
                    <span>
                      <b>{spec?.model}</b>
                      <small>{placement.position.map((v) => v.toFixed(0)).join(" / ")} мм</small>
                    </span>
                    <em className={status?.collides || status?.outside ? "bad" : ""}>
                      {status?.collides || status?.outside ? "!" : "OK"}
                    </em>
                  </button>
                );
              })}
            </div>
          )}

          {selectedPlacement && (
            <PlacementEditor placement={selectedPlacement} evaluation={evaluation} />
          )}

          <div className="component-library">
            <span className="subheading">Добавить из библиотеки</span>
            {componentsLibrary.map((component) => (
              <div className="library-row" key={component.id}>
                <span className="component-swatch" style={{ background: component.color }} />
                <span className="library-name">
                  <b>
                    {component.model}
                    <em className={`visual-kind ${component.visual?.kind ?? "box"}`}>
                      {component.visual?.kind === "stl"
                        ? "3D"
                        : component.visual?.kind === "top-texture"
                          ? "IMG"
                          : "AUTO"}
                    </em>
                  </b>
                  <small>
                    {component.dimensionsMm.length} × {component.dimensionsMm.width} ×{" "}
                    {component.dimensionsMm.height} мм
                  </small>
                </span>
                <button
                  type="button"
                  onClick={() => void addComponentSmart(component)}
                  aria-label={`Добавить ${component.model}`}
                >
                  +
                </button>
              </div>
            ))}
          </div>
          {selectedPlan && (
            <p className="component-tip">
              Пак занимает {selectedPlan.metrics.utilizationPercent.toFixed(1)}% внутреннего объёма
              с учётом обмотки и keep-out.
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
