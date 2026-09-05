import { cellsLibrary } from "../data/library";
import { sparkCaseAsset } from "../data/enclosures";
import { activeServiceReservations, separatedOffsets } from "../store/service-reservations";
import type {
  Axis,
  PackFace,
  PackingMode,
  PackRequest,
  PlannerConfig,
  ServiceReservation,
} from "../bindings";
import { usePlannerStore } from "../store/planner-store";
import { NumberField } from "./NumberField";

const ORIENTATIONS: Array<{ value: PackRequest["orientation"]; label: string }> = [
  { value: "auto", label: "Авто" },
  { value: "x", label: "Вдоль X" },
  { value: "y", label: "Поперёк Y" },
  { value: "z", label: "Стоя Z" },
];

const FACE_LABELS: Record<PackFace, string> = {
  "positive-x": "+X нос",
  "negative-x": "−X хвост",
  "positive-y": "+Y борт",
  "negative-y": "−Y борт",
};

export function ControlPanel({ config }: { config: PlannerConfig }) {
  const setEnclosureKind = usePlannerStore((state) => state.setEnclosureKind);
  const setEnclosureDimension = usePlannerStore((state) => state.setEnclosureDimension);
  const setPackField = usePlannerStore((state) => state.setPackField);
  const setTolerance = usePlannerStore((state) => state.setTolerance);
  const setService = usePlannerStore((state) => state.setService);
  const setWiringExitMode = usePlannerStore((state) => state.setWiringExitMode);
  const selectedCell =
    cellsLibrary.find((cell) => cell.id === config.pack.cellId) ?? cellsLibrary[0];
  const combinedExit = config.pack.serviceReservations.find(
    (reservation) => reservation.kind === "wiring-exit",
  );
  const powerExit = config.pack.serviceReservations.find(
    (reservation) => reservation.kind === "power-output",
  );
  const balanceExit = config.pack.serviceReservations.find(
    (reservation) => reservation.kind === "balance-harness",
  );
  const activeReservations = activeServiceReservations(config.pack);
  const wiringEnabled = activeReservations.some((reservation) => reservation.enabled);

  const togglePacking = (mode: PackingMode) => {
    const current = config.pack.packingModes;
    if (current.includes(mode) && current.length === 1) return;
    setPackField(
      "packingModes",
      current.includes(mode) ? current.filter((item) => item !== mode) : [...current, mode],
    );
  };

  const setAllWiringEnabled = (enabled: boolean) => {
    activeReservations.forEach((reservation) => setService(reservation.id, { enabled }));
  };

  const setReservationFace = (reservation: ServiceReservation, face: PackFace) => {
    if (
      config.pack.wiringExitMode === "separate" &&
      powerExit &&
      balanceExit &&
      (reservation.kind === "power-output" || reservation.kind === "balance-harness")
    ) {
      const other = reservation.kind === "power-output" ? balanceExit : powerExit;
      if (other.face === face) {
        const offsets = separatedOffsets(face, powerExit, balanceExit);
        setService(powerExit.id, {
          face,
          offsetMm: offsets.power,
        });
        setService(balanceExit.id, {
          face,
          offsetMm: offsets.balance,
        });
        return;
      }
    }
    setService(reservation.id, { face, offsetMm: [0, 0, 0] });
  };

  const reservationFields = (reservation: ServiceReservation) => (
    <div className="service-controls">
      <label className="select-field compact">
        <span>Выход</span>
        <select
          value={reservation.face}
          onChange={(event) =>
            setReservationFace(reservation, event.currentTarget.value as PackFace)
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
            min={1}
            unit="мм"
            onChange={(value) => {
              const size = [...reservation.sizeMm] as [number, number, number];
              size[index] = value;
              setService(reservation.id, { sizeMm: size });
            }}
          />
        ))}
      </div>
      {Math.abs((reservation.offsetMm ?? [0, 0, 0])[reservation.face.endsWith("x") ? 1 : 0]) >
        0.05 && (
        <div className="service-offset">
          <span>
            Вдоль грани:{" "}
            {(reservation.offsetMm ?? [0, 0, 0])[reservation.face.endsWith("x") ? 1 : 0].toFixed(1)}{" "}
            мм
          </span>
          <button type="button" onClick={() => setService(reservation.id, { offsetMm: [0, 0, 0] })}>
            по центру
          </button>
        </div>
      )}
    </div>
  );

  return (
    <aside className="control-panel side-panel">
      <div className="panel-heading">
        <span className="eyebrow">Исходные данные</span>
        <h2>Геометрия проекта</h2>
      </div>

      <section className="control-section">
        <div className="section-title">
          <h3>Внутренний объём</h3>
          <span>{config.enclosure.kind === "box" ? "BOX / MM" : "STL / 0.5 MM"}</span>
        </div>
        <label className="select-field enclosure-select">
          <span>Форма корпуса</span>
          <select
            aria-label="Форма корпуса"
            value={config.enclosure.kind}
            onChange={(event) =>
              setEnclosureKind(event.currentTarget.value as "box" | "mesh-heightmap")
            }
          >
            <option value="mesh-heightmap">Spark case · точная STL</option>
            <option value="box">Параллелепипед</option>
          </select>
        </label>
        {config.enclosure.kind === "mesh-heightmap" ? (
          <div className="mesh-enclosure-readout">
            <div className="mesh-enclosure-mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <div>
              <strong>{sparkCaseAsset.label}</strong>
              <span>
                {sparkCaseAsset.dimensionsMm.length.toFixed(1)} ×{" "}
                {sparkCaseAsset.dimensionsMm.width.toFixed(1)} ×{" "}
                {sparkCaseAsset.dimensionsMm.height.toFixed(1)} мм
              </span>
              <small>
                {sparkCaseAsset.meshTriangles.toLocaleString("ru-RU")} треугольников · внутренняя
                поверхность
              </small>
            </div>
            <em>EXACT</em>
          </div>
        ) : (
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
        )}
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
          <h3>Выход проводов</h3>
          <span>CABLE KEEP-OUT</span>
        </div>
        <div className={`wiring-card ${wiringEnabled ? "enabled" : ""}`}>
          <div className="wiring-card-head">
            <span className="cable-glyph" aria-hidden="true">
              <i />
              <i />
            </span>
            <span className="wiring-copy">
              <b>
                {config.pack.wiringExitMode === "combined"
                  ? "Силовые + балансировка"
                  : "Два раздельных выхода"}
              </b>
              <small>
                {config.pack.wiringExitMode === "combined"
                  ? "Один общий кабельный коридор"
                  : "Независимые позиции и габариты"}
              </small>
            </span>
            <button
              type="button"
              className={`wiring-state ${wiringEnabled ? "active" : ""}`}
              aria-pressed={wiringEnabled}
              onClick={() => setAllWiringEnabled(!wiringEnabled)}
            >
              {wiringEnabled ? "В расчёте" : "Исключён"}
            </button>
          </div>
          {config.pack.wiringExitMode === "combined" &&
            combinedExit &&
            reservationFields(combinedExit)}
          {config.pack.wiringExitMode === "separate" && (
            <div className="split-exit-summary">
              {activeReservations.map((reservation) => (
                <span key={reservation.id}>
                  <i className={reservation.kind} />
                  {reservation.kind === "power-output" ? "Силовые" : "Балансировка"}
                  <b>{FACE_LABELS[reservation.face]}</b>
                </span>
              ))}
            </div>
          )}
        </div>

        <details
          className="wiring-advanced"
          open={config.pack.wiringExitMode === "separate" ? true : undefined}
        >
          <summary>
            <span>
              <b>Advanced settings</b>
              <small>разнести выходы по разным местам</small>
            </span>
            <i aria-hidden="true" />
          </summary>
          <div className="advanced-wiring-body">
            <span className="field-label">Расположение проводов</span>
            <div className="segmented wiring-mode" role="radiogroup">
              <button
                type="button"
                role="radio"
                aria-checked={config.pack.wiringExitMode === "combined"}
                className={config.pack.wiringExitMode === "combined" ? "active" : ""}
                onClick={() => setWiringExitMode("combined")}
              >
                Вместе
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={config.pack.wiringExitMode === "separate"}
                className={config.pack.wiringExitMode === "separate" ? "active" : ""}
                onClick={() => setWiringExitMode("separate")}
              >
                Раздельно
              </button>
            </div>
            {config.pack.wiringExitMode === "separate" && (
              <div className="separate-reservations">
                {[powerExit, balanceExit].map(
                  (reservation) =>
                    reservation && (
                      <div className="service-reservation" key={reservation.id}>
                        <div className="service-heading">
                          <span className={`service-dot ${reservation.kind}`} />
                          <b>
                            {reservation.kind === "power-output"
                              ? "Силовые провода"
                              : "Балансировочный шлейф"}
                          </b>
                          <button
                            type="button"
                            aria-pressed={reservation.enabled}
                            className={reservation.enabled ? "active" : ""}
                            onClick={() =>
                              setService(reservation.id, { enabled: !reservation.enabled })
                            }
                          >
                            {reservation.enabled ? "ON" : "OFF"}
                          </button>
                        </div>
                        {reservationFields(reservation)}
                      </div>
                    ),
                )}
              </div>
            )}
          </div>
        </details>
      </section>
    </aside>
  );
}
