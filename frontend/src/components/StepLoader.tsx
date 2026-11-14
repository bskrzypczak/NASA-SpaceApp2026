import { useEffect, useState } from 'react';

export interface LoaderStep {
  /** Seconds after start when this step is shown as active (an estimate — the backend does not stream progress). */
  at: number;
  label: string;
}

/**
 * Progress card for long backend jobs (calendar, scenarios, nearby): animated bar, estimated steps,
 * elapsed time, and a reassuring note when it takes longer than usual.
 */
export function StepLoader({
  title,
  steps,
  hint,
  slowAfterS = 120,
}: {
  title: string;
  steps: LoaderStep[];
  hint?: string;
  slowAfterS?: number;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setElapsed((Date.now() - t0) / 1000), 250);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="panel step-loader" role="status" aria-live="polite" aria-busy="true">
      <div className="step-loader__head">
        <strong>{title}</strong>
        <span className="mono muted">{formatElapsed(elapsed)}</span>
      </div>
      <div className="progress" aria-hidden="true">
        <span />
      </div>
      <ol className="step-loader__steps">
        {steps.map((s, i) => {
          const next = steps[i + 1];
          const done = next ? elapsed >= next.at : false;
          const active = elapsed >= s.at && !done;
          return (
            <li key={s.label} className={done ? 'is-done' : active ? 'is-active' : ''}>
              <span aria-hidden="true" className="step-loader__icon">
                {done ? '✓' : active ? '●' : '○'}
              </span>
              {s.label}
            </li>
          );
        })}
      </ol>
      {hint && <span className="muted step-loader__hint">{hint}</span>}
      {elapsed > slowAfterS && (
        <span className="step-loader__hint">! Taking longer than usual — NASA data services can be slow. It will finish or show an error; no need to reload.</span>
      )}
    </div>
  );
}

function formatElapsed(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m ? `${m} min ${sec.toString().padStart(2, '0')} s` : `${sec} s`;
}
