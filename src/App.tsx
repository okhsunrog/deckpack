import { useEffect, useMemo } from "react";
import "./App.css";
import { ControlPanel } from "./components/ControlPanel";
import { MetricsBar } from "./components/MetricsBar";
import { ResultsPanel } from "./components/ResultsPanel";
import { useLayoutEngine } from "./components/use-layout-engine";
import { componentsLibrary, getCell } from "./data/library";
import { evaluateWorkspace } from "./domain/geometry";
import { activeServiceReservations } from "./domain/service-reservations";
import { PlannerScene } from "./scene/PlannerScene";
import { usePlannerStore } from "./store/planner-store";

function exportProject() {
  const state = usePlannerStore.getState();
  const payload = JSON.stringify(
    { schemaVersion: 2, config: state.config, components: state.placements },
    null,
    2,
  );
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "deckpack-project.json";
  link.click();
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function App() {
  const config = usePlannerStore((state) => state.config);
  const placements = usePlannerStore((state) => state.placements);
  const selectedPlanId = usePlannerStore((state) => state.selectedPlanId);
  const selectedComponentId = usePlannerStore((state) => state.selectedComponentId);
  const setSelectedPlanId = usePlannerStore((state) => state.setSelectedPlanId);
  const setSelectedComponentId = usePlannerStore((state) => state.setSelectedComponentId);
  const updateComponent = usePlannerStore((state) => state.updateComponent);
  const removeComponent = usePlannerStore((state) => state.removeComponent);
  const setService = usePlannerStore((state) => state.setService);
  const resetProject = usePlannerStore((state) => state.resetProject);
  const cell = getCell(config.pack.cellId);
  const { plans, exploredCount, loading } = useLayoutEngine(config, cell);
  const selectedPlan = plans.find((plan) => plan.id === selectedPlanId) ?? plans[0];

  useEffect(() => {
    if (!loading && selectedPlan && selectedPlan.id !== selectedPlanId) {
      setSelectedPlanId(selectedPlan.id);
    }
  }, [loading, selectedPlan, selectedPlanId, setSelectedPlanId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const editingText =
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (editingText) return;
      if (event.key === "Escape") {
        setSelectedComponentId(undefined);
        return;
      }
      if (!selectedComponentId || (event.key !== "Delete" && event.key !== "Backspace")) return;
      event.preventDefault();
      removeComponent(selectedComponentId);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [removeComponent, selectedComponentId, setSelectedComponentId]);

  const evaluation = useMemo(
    () =>
      selectedPlan ? evaluateWorkspace(config.enclosure, selectedPlan, placements) : undefined,
    [config.enclosure, placements, selectedPlan],
  );

  const totalCells = config.pack.seriesCount * config.pack.parallelCount;
  const packVoltage = config.pack.seriesCount * cell.nominalVoltageV;
  const packEnergyWh = packVoltage * config.pack.parallelCount * cell.capacityAh;
  const enclosureDimension = (value: number) =>
    config.enclosure.kind === "mesh-heightmap" ? value.toFixed(1) : value;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <h1>DECKPACK</h1>
            <span>PACKAGING BENCH / V1</span>
          </div>
        </div>
        <div className="project-readout">
          <span>
            {config.pack.seriesCount}S{config.pack.parallelCount}P
          </span>
          <b>
            {totalCells} × {cell.model}
          </b>
          <small>
            {packVoltage.toFixed(1)} V nominal · {packEnergyWh.toFixed(0)} Wh
          </small>
        </div>
        <div className="header-actions">
          <button type="button" onClick={exportProject}>
            Экспорт JSON
          </button>
          <button type="button" className="quiet-button" onClick={resetProject}>
            Сбросить
          </button>
        </div>
      </header>

      <div className="workspace-grid">
        <ControlPanel config={config} />

        <section className="viewport-column">
          <div className="scene-header">
            <div>
              <span className="eyebrow">Рабочий объём</span>
              <b>
                {enclosureDimension(config.enclosure.dimensionsMm.length)} ×{" "}
                {enclosureDimension(config.enclosure.dimensionsMm.width)} ×{" "}
                {enclosureDimension(config.enclosure.dimensionsMm.height)} мм
              </b>
            </div>
            <div className="scene-legend">
              <span>
                <i className="legend-cell" /> S-группы
              </span>
              <span>
                <i className="legend-chain" /> S-цепь
              </span>
              <span>
                <i className="legend-keepout" /> keep-out
              </span>
              <span>
                <i className="legend-collision" /> коллизия
              </span>
            </div>
          </div>
          <div className="scene-frame">
            <PlannerScene
              enclosure={config.enclosure}
              plan={selectedPlan}
              components={placements}
              componentSpecs={componentsLibrary}
              evaluation={evaluation}
              selectedComponentId={selectedComponentId}
              onSelectComponent={setSelectedComponentId}
              onMoveComponent={(id, position) => updateComponent(id, { position })}
              onRemoveComponent={removeComponent}
              serviceReservations={activeServiceReservations(config.pack)}
              onUpdateService={setService}
            />
            <div className="axis-ruler" aria-hidden="true">
              <span className="ruler-label tail">TAIL / −X</span>
              {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((value) => (
                <i key={value} style={{ left: `${value}%` }}>
                  <small>{value}</small>
                </i>
              ))}
              <span className="ruler-label nose">NOSE / +X</span>
              {selectedPlan && (
                <span
                  className="mass-marker"
                  style={{ left: `${selectedPlan.metrics.centerOfMassPercent}%` }}
                  title={`Центр массы ${selectedPlan.metrics.centerOfMassXmm.toFixed(1)} мм`}
                >
                  CM
                </span>
              )}
            </div>
            <div className="scene-help">
              ЛКМ: выбрать / перетащить · ПКМ по объекту: меню · Delete: удалить · колесо: масштаб
            </div>
            <div className={`scene-status ${evaluation?.hasCollision ? "invalid" : ""}`}>
              <span />
              {loading
                ? "Перебор геометрии…"
                : evaluation?.hasCollision
                  ? "Проверьте коллизии"
                  : "Геометрия валидна"}
            </div>
          </div>
          <MetricsBar
            plan={selectedPlan}
            evaluation={evaluation}
            profiled={config.enclosure.kind === "mesh-heightmap"}
          />
        </section>

        <ResultsPanel
          plans={plans}
          exploredCount={exploredCount}
          loading={loading}
          selectedPlan={selectedPlan}
          evaluation={evaluation}
        />
      </div>
    </main>
  );
}

export default App;
