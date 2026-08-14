import { boxSize } from "../domain/geometry";
import type { PackPlan, WorkspaceEvaluation } from "../domain/types";

function formatVolume(valueMm3: number) {
  return `${(valueMm3 / 1_000_000).toFixed(2)} л`;
}

export function MetricsBar({
  plan,
  evaluation,
}: {
  plan?: PackPlan;
  evaluation?: WorkspaceEvaluation;
}) {
  if (!plan) {
    return (
      <div className="metrics-bar empty-metrics">
        Нет допустимой раскладки для текущих ограничений
      </div>
    );
  }
  const freeSize = boxSize(evaluation?.largestFreeBox.box ?? plan.metrics.largestFreeBox.box);
  return (
    <div className="metrics-bar">
      <div className="metric primary-metric">
        <span>Рейтинг</span>
        <strong>{plan.metrics.score}</strong>
        <small>/100</small>
      </div>
      <div className="metric">
        <span>Центр массы X</span>
        <strong>{plan.metrics.centerOfMassXmm.toFixed(1)}</strong>
        <small> мм</small>
      </div>
      <div className="metric">
        <span>Последовательная цепь</span>
        <strong>{plan.metrics.seriesChainLengthMm.toFixed(0)}</strong>
        <small> мм</small>
      </div>
      <div className="metric">
        <span>Минимальный зазор</span>
        <strong>{plan.metrics.minClearanceMm.toFixed(1)}</strong>
        <small> мм</small>
      </div>
      <div className="metric">
        <span>Свободный объём</span>
        <strong>{formatVolume(evaluation?.freeVolumeMm3 ?? 0)}</strong>
        {evaluation && <small> {evaluation.freePercent.toFixed(0)}%</small>}
      </div>
      <div className="metric free-box-metric">
        <span>Крупнейший свободный BOX</span>
        <strong>{freeSize.map((value) => value.toFixed(0)).join(" × ")}</strong>
        <small> мм</small>
      </div>
    </div>
  );
}
