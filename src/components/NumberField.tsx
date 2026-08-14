interface NumberFieldProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
}

export function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: NumberFieldProps) {
  return (
    <label className="number-field">
      <span>{label}</span>
      <span className="number-input-wrap">
        <input
          type="number"
          value={Number.isFinite(value) ? value : ""}
          min={min}
          max={max}
          step={step}
          onChange={(event) => {
            const parsed = event.currentTarget.valueAsNumber;
            if (Number.isFinite(parsed)) onChange(parsed);
          }}
        />
        {unit && <span className="input-unit">{unit}</span>}
      </span>
    </label>
  );
}
