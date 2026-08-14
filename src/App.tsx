import { useEffect, useMemo } from "react";
import "./App.css";
import { ControlPanel } from "./components/ControlPanel";
import { MetricsBar } from "./components/MetricsBar";
import { ResultsPanel } from "./components/ResultsPanel";
import { useLayoutEngine } from "./components/use-layout-engine";
import { componentsLibrary, getCell } from "./data/library";
import { evaluateWorkspace } from "./domain/geometry";
import { generateHolder } from "./domain/holder";
import { planSignature } from "./domain/packing";
import { activeServiceReservations } from "./domain/service-reservations";
import { PlannerScene } from "./scene/PlannerScene";
import { usePlannerStore } from "./store/planner-store";
import type { CellSpec, PackPlan } from "./domain/types";

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportProject() {
  const state = usePlannerStore.getState();
  const payload = JSON.stringify(
    { schemaVersion: 2, config: state.config, components: state.placements },
    null,
    2,
  );
  download(new Blob([payload], { type: "application/json" }), "deckpack-project.json");
}

function exportHolder(plan: PackPlan, cell: CellSpec) {
  const state = usePlannerStore.getState();
  try {
    const build = generateHolder(plan, cell, state.config.pack.toleranceStack);
    const thinnest = Math.min(...build.pieces.map((piece) => piece.minWallMm));
    download(
      new Blob([build.stl], { type: "model/stl" }),
      `deckpack-holder-${plan.packingMode}.stl`,
    );
    if (thinnest < 0.4) {
      window.alert(
        `Внимание: минимальная стенка холдера ${thinnest.toFixed(2)} мм. ` +
          "Увеличьте слой «Стенка холдера» (staggered) или Group separator (brick).",
      );
    }
  } catch (error) {
    window.alert(`Не удалось сгенерировать холдер: ${(error as Error).message}`);
  }
}

function App() {
  const config = usePlannerStore((state) => state.config);
  const placements = usePlannerStore((state) => state.placements);
  const selectedPlanId = usePlannerStore((state) => state.selectedPlanId);
  const selectedPlanKey = usePlannerStore((state) => state.selectedPlanKey);
  const selectedComponentId = usePlannerStore((state) => state.selectedComponentId);
  const setSelectedPlan = usePlannerStore((state) => state.setSelectedPlan);
  const setSelectedComponentId = usePlannerStore((state) => state.setSelectedComponentId);
  const updateComponent = usePlannerStore((state) => state.updateComponent);
  const removeComponent = usePlannerStore((state) => state.removeComponent);
  const setService = usePlannerStore((state) => state.setService);
  const resetProject = usePlannerStore((state) => state.resetProject);
  const showHolders = usePlannerStore((state) => state.showHolders);
  const setShowHolders = usePlannerStore((state) => state.setShowHolders);
  const cell = getCell(config.pack.cellId);
  const { plans, exploredCount, loading } = useLayoutEngine(config, cell);
  // Ids change whenever tolerances or the enclosure change, so fall back to
  // the lattice signature before giving up and taking the top-ranked plan.
  const selectedPlan =
    plans.find((plan) => plan.id === selectedPlanId) ??
    plans.find((plan) => planSignature(plan) === selectedPlanKey) ??
    plans[0];

  useEffect(() => {
    if (!loading && selectedPlan && selectedPlan.id !== selectedPlanId) {
      setSelectedPlan(selectedPlan.id, planSignature(selectedPlan));
    }
  }, [loading, selectedPlan, selectedPlanId, setSelectedPlan]);

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
          <button
            type="button"
            disabled={!selectedPlan || selectedPlan.orientation === "z"}
            title="STL волновых ложементов под выбранную раскладку"
            onClick={() => selectedPlan && exportHolder(selectedPlan, cell)}
          >
            Холдер STL
          </button>
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
              <button
                type="button"
                className={`legend-toggle ${showHolders ? "active" : ""}`}
                aria-pressed={showHolders}
                onClick={() => setShowHolders(!showHolders)}
              >
                холдер
              </button>
            </div>
          </div>
          <div className="scene-frame">
            <PlannerScene
              enclosure={config.enclosure}
              plan={selectedPlan}
              cell={cell}
              toleranceStack={config.pack.toleranceStack}
              showHolders={showHolders}
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
