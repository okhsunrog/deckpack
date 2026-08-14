import { cellsLibrary } from "../data/library";
import type { Axis, PackingMode, PackRequest, PlannerConfig } from "../domain/types";
import { usePlannerStore } from "../store/planner-store";
import { NumberField } from "./NumberField";

const ORIENTATIONS: Array<{ value: PackRequest["orientation"]; label: string }> = [
  { value: "auto", label: "Авто" },
  { value: "x", label: "Вдоль X" },
  { value: "y", label: "Поперёк Y" },
  { value: "z", label: "Стоя Z" },
];

const FACE_LABELS: Record<string, string> = {
  "positive-x": "+X нос",
  "negative-x": "−X хвост",
  "positive-y": "+Y борт",
  "negative-y": "−Y борт",
};

export function ControlPanel({ config }: { config: PlannerConfig }) {
  const setEnclosureDimension = usePlannerStore((state) => state.setEnclosureDimension);
  const setPackField = usePlannerStore((state) => state.setPackField);
  const setTolerance = usePlannerStore((state) => state.setTolerance);
  const setService = usePlannerStore((state) => state.setService);
  const selectedCell =
    cellsLibrary.find((cell) => cell.id === config.pack.cellId) ?? cellsLibrary[0];

  const togglePacking = (mode: PackingMode) => {
    const current = config.pack.packingModes;
    if (current.includes(mode) && current.length === 1) return;
    setPackField(
      "packingModes",
      current.includes(mode) ? current.filter((item) => item !== mode) : [...current, mode],
    );
  };

  return (
    <aside className="control-panel side-panel">
      <div className="panel-heading">
        <span className="eyebrow">Исходные данные</span>
        <h2>Геометрия проекта</h2>
      </div>

      <section className="control-section">
        <div className="section-title">
          <h3>Внутренний объём</h3>
          <span>BOX / MM</span>
        </div>
        <div className="dimension-grid">
          <NumberField
            label="Длина X"
            value={config.enclosure.dimensionsMm.length}
            min={100}
            unit="мм"
            onChange={(value) => setEnclosureDimension("length", value)}
          />
          <NumberField
            label="Ширина Y"
            value={config.enclosure.dimensionsMm.width}
            min={50}
            unit="мм"
            onChange={(value) => setEnclosureDimension("width", value)}
          />
          <NumberField
            label="Высота Z"
            value={config.enclosure.dimensionsMm.height}
            min={10}
            unit="мм"
            onChange={(value) => setEnclosureDimension("height", value)}
          />
        </div>
      </section>

      <section className="control-section">
        <div className="section-title">
          <h3>Батарея</h3>
          <span>N S M P</span>
        </div>
        <div className="pack-ratio">
          <NumberField
            label="S-групп"
            value={config.pack.seriesCount}
            min={1}
            max={32}
            onChange={(value) => setPackField("seriesCount", Math.round(value))}
          />
          <span className="ratio-mark">S</span>
          <NumberField
            label="Банок в P"
            value={config.pack.parallelCount}
            min={1}
            max={16}
            onChange={(value) => setPackField("parallelCount", Math.round(value))}
          />
          <span className="ratio-mark">P</span>
        </div>
        <label className="select-field">
          <span>Тип банки</span>
          <select
            value={config.pack.cellId}
            onChange={(event) => setPackField("cellId", event.currentTarget.value)}
          >
            {cellsLibrary.map((cell) => (
              <option key={cell.id} value={cell.id}>
                {cell.manufacturer} {cell.model}
              </option>
            ))}
          </select>
        </label>
        <div className="cell-facts">
          <span>Ø {selectedCell.sleevedDiameterMm.toFixed(2)} мм</span>
          <span>H {selectedCell.sleevedHeightMm.toFixed(2)} мм</span>
          <span>{selectedCell.massG} г</span>
          <a href={selectedCell.source.url} target="_blank" rel="noreferrer">
            источник ↗
          </a>
        </div>
        <div className="field-group">
          <span className="field-label">Ось банки</span>
          <div className="segmented orientation-options">
            {ORIENTATIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={config.pack.orientation === option.value ? "active" : ""}
                onClick={() => setPackField("orientation", option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="packing-options">
          <button
            type="button"
            className={config.pack.packingModes.includes("brick") ? "packing-active" : ""}
            onClick={() => togglePacking("brick")}
          >
            <span className="packing-icon brick-icon" aria-hidden="true" />
            <span>
              <b>Brick</b>
              <small>ортогональная сетка</small>
            </span>
          </button>
          <button
            type="button"
            className={config.pack.packingModes.includes("staggered") ? "packing-active" : ""}
            onClick={() => togglePacking("staggered")}
          >
            <span className="packing-icon staggered-icon" aria-hidden="true" />
            <span>
              <b>Staggered</b>
              <small>кастомный холдер</small>
            </span>
          </button>
        </div>
        <NumberField
          label="Не более слоёв"
          value={config.pack.maxLayers}
          min={1}
          max={8}
          onChange={(value) => setPackField("maxLayers", Math.round(value))}
        />
      </section>

      <section className="control-section">
        <div className="section-title">
          <h3>Стек допусков</h3>
          <span>РАСЧЁТНЫЙ</span>
        </div>
        <p className="section-note">Каждый слой участвует в габарите, а не только в подписи.</p>
        <div className="tolerance-list">
          {config.pack.toleranceStack.map((layer) => (
            <NumberField
              key={layer.id}
              label={layer.label}
              value={layer.thicknessMm}
              min={0}
              step={0.1}
              unit="мм"
              onChange={(value) => setTolerance(layer.id, value)}
            />
          ))}
        </div>
      </section>

      <section className="control-section">
        <div className="section-title">
          <h3>Резерв проводки</h3>
          <span>KEEP-OUT</span>
        </div>
        {config.pack.serviceReservations.map((reservation) => (
          <div className="service-reservation" key={reservation.id}>
            <label className="switch-row">
              <span>{reservation.label}</span>
              <input
                type="checkbox"
                checked={reservation.enabled}
                onChange={(event) =>
                  setService(reservation.id, { enabled: event.currentTarget.checked })
                }
              />
            </label>
            <div className="service-controls">
              <label className="select-field compact">
                <span>Грань</span>
                <select
                  value={reservation.face}
                  onChange={(event) =>
                    setService(reservation.id, {
                      face: event.currentTarget.value as typeof reservation.face,
                    })
                  }
                >
                  {Object.entries(FACE_LABELS).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="service-size">
                {(["x", "y", "z"] as Axis[]).map((axis, index) => (
                  <NumberField
                    key={axis}
                    label={axis.toUpperCase()}
                    value={reservation.sizeMm[index]}
                    min={0}
                    unit="мм"
                    onChange={(value) => {
                      const size = [...reservation.sizeMm] as [number, number, number];
                      size[index] = value;
                      setService(reservation.id, { sizeMm: size });
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        ))}
      </section>
    </aside>
  );
}
