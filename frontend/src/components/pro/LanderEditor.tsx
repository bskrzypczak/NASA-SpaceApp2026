import { useEffect, useState } from 'react';
import type { Hardware, SimulationResult } from '../../api/types';
import { LANDER_PRESETS, landerName, nightEnduranceH, presetFor } from '../../lib/landers';
import { DEFAULT_HARDWARE } from '../../lib/simModel';

interface Field {
  key: keyof Hardware;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
}

const FIELDS: Field[] = [
  { key: 'batteryWh', label: 'Battery capacity', unit: 'Wh', min: 100, max: 100_000, step: 100 },
  { key: 'solarW', label: 'Solar array (full Sun)', unit: 'W', min: 0, max: 10_000, step: 10 },
  { key: 'dayLoadW', label: 'Load in sunlight', unit: 'W', min: 0, max: 5_000, step: 10 },
  { key: 'nightLoadW', label: 'Load in darkness', unit: 'W', min: 0, max: 5_000, step: 5 },
  { key: 'reservePct', label: 'Battery reserve', unit: '%', min: 0, max: 90, step: 1 },
  { key: 'panelHeightM', label: 'Panel height', unit: 'm', min: 0, max: 50, step: 0.5 },
  { key: 'mastHeightM', label: 'Antenna mast', unit: 'm', min: 0, max: 50, step: 0.5 },
];

const fmtH = (h: number) => (Number.isFinite(h) ? (h >= 48 ? `${h.toFixed(0)} h (${(h / 24).toFixed(1)} d)` : `${h.toFixed(1)} h`) : '∞');

/**
 * Pro → Lander: the power system behind the battery curve. Presets document their sources; any
 * change re-runs this mission and becomes the default for new simulations, dates, nearby and scenarios.
 */
export function LanderEditor({
  result,
  onRun,
  running,
  error,
}: {
  result: SimulationResult;
  onRun: (hw: Hardware) => void;
  running: boolean;
  error: Error | null;
}) {
  const current: Hardware = { ...DEFAULT_HARDWARE, ...result.input.hardware };
  const [draft, setDraft] = useState<Hardware>(current);
  const [raw, setRaw] = useState<Record<string, string>>({});
  useEffect(() => {
    setDraft(current);
    setRaw({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.id]);

  const invalid = FIELDS.filter((f) => {
    const v = draft[f.key];
    return !Number.isFinite(v) || v < f.min || v > f.max || (raw[f.key] !== undefined && raw[f.key].trim() === '');
  }).map((f) => f.key);
  const changed = FIELDS.some((f) => draft[f.key] !== current[f.key]);
  const preset = presetFor(draft);

  const endurance = nightEnduranceH(draft);
  const surplus = draft.solarW - draft.dayLoadW;
  const rechargeH = surplus > 0 ? (draft.batteryWh * (1 - draft.reservePct / 100)) / surplus : Infinity;
  const longestNight = result.summary.longestNightH;

  return (
    <div className="lander">
      <div className="lander__presets" role="radiogroup" aria-label="Lander preset">
        {LANDER_PRESETS.map((p) => {
          const on = preset?.id === p.id;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`lander__preset${on ? ' is-on' : ''}`}
              onClick={() => {
                setDraft({ ...p.hardware });
                setRaw({});
              }}
            >
              <span className="lander__preset-name">
                {on ? '● ' : '○ '}
                {p.name}
              </span>
              <span className="mono lander__preset-spec">
                {(p.hardware.batteryWh / 1000).toFixed(1)} kWh · {p.hardware.solarW} W · {p.hardware.nightLoadW} W night
              </span>
              <span className="lander__preset-basis">{p.basis}</span>
            </button>
          );
        })}
        {!preset && <p className="lander__custom">● Custom values — not one of the presets.</p>}
      </div>

      <div className="lander__form">
        <div className="lander__fields">
          {FIELDS.map((f) => (
            <label key={f.key} className="field lander__field">
              <span className="muted">{f.label}</span>
              <span className="lander__input">
                <input
                  type="number"
                  inputMode="decimal"
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  value={raw[f.key] ?? String(draft[f.key])}
                  aria-invalid={invalid.includes(f.key)}
                  onChange={(e) => {
                    const text = e.target.value;
                    setRaw((r) => ({ ...r, [f.key]: text }));
                    const v = Number(text);
                    if (text.trim() !== '' && Number.isFinite(v)) setDraft((d) => ({ ...d, [f.key]: v }));
                  }}
                />
                <span aria-hidden="true">{f.unit}</span>
              </span>
            </label>
          ))}
        </div>

        <dl className="details lander__derived">
          <div>
            <dt>Darkness on battery (full → reserve)</dt>
            <dd style={{ color: endurance < longestNight ? 'var(--danger-text)' : undefined }}>
              {fmtH(endurance)}
              {endurance < longestNight ? ` ! < longest night ${longestNight.toFixed(0)} h` : ' ✓'}
            </dd>
          </div>
          <div>
            <dt>Surplus in full Sun</dt>
            <dd style={{ color: surplus <= 0 ? 'var(--danger-text)' : undefined }}>
              {surplus > 0 ? `+${surplus} W` : `! ${surplus} W — never recharges`}
            </dd>
          </div>
          <div>
            <dt>Recharge reserve → full</dt>
            <dd>{fmtH(rechargeH)}</dd>
          </div>
        </dl>

        {invalid.length > 0 && (
          <p className="error" role="alert" style={{ margin: 0 }}>
            ! Check {invalid.map((k) => FIELDS.find((f) => f.key === k)!.label.toLowerCase()).join(', ')}.
          </p>
        )}
        {error && (
          <p className="error" role="alert" style={{ margin: 0 }}>
            ! Re-run failed: {error.message}
          </p>
        )}

        <div className="lander__actions">
          <button type="button" className="btn btn--primary" disabled={!changed || invalid.length > 0 || running} onClick={() => onRun(draft)}>
            {running ? 'Running…' : '▶ Re-run with this lander'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!changed || running}
            onClick={() => {
              setDraft(current);
              setRaw({});
            }}
          >
            Reset
          </button>
          <span className="muted lander__note">
            This result: <strong>{landerName(current)}</strong>. The lander you run becomes the default for new simulations, dates, nearby and scenarios.
          </span>
        </div>
      </div>
    </div>
  );
}
