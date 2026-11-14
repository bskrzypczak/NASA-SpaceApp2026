import { LAUNCH_SITES, DEFAULT_LAUNCH_SITE_ID } from '../../data/launchSites';
import { formatLat, formatLon } from '../../lib/coords';

/** Radio list of launch sites; the NASA pad is the default. */
export function LaunchSitePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <fieldset className="launch-picker">
      <legend className="eyebrow">Launch site on Earth</legend>
      <div className="launch-picker__list" role="radiogroup">
        {LAUNCH_SITES.map((s) => (
          <label key={s.id} className={`launch-picker__item${value === s.id ? ' is-selected' : ''}`}>
            <input type="radio" name="launch-site" value={s.id} checked={value === s.id} onChange={() => onChange(s.id)} />
            <span className="launch-picker__text">
              <span className="launch-picker__name">
                {s.name}
                {s.id === DEFAULT_LAUNCH_SITE_ID && <span className="launch-picker__tag">default</span>}
              </span>
              <span className="muted">
                {s.operator} · {s.country}
              </span>
              <span className="mono muted" style={{ fontSize: 12 }}>
                {formatLat(s.lat, 2)} · {formatLon(s.lon, 2)}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
