import { useEffect, useState, type FormEvent } from 'react';
import { parseLat, parseLon, type LatLon } from '../lib/coords';

interface CoordinateBarProps {
  value: LatLon;
  /** Called with valid coordinates when the user presses Next. */
  onNext: (point: LatLon) => void;
}

/** LAT / LON / ELEV bar under the Moon model, with the Next button. */
export function CoordinateBar({ value, onNext }: CoordinateBarProps) {
  const [latText, setLatText] = useState(value.lat.toFixed(4));
  const [lonText, setLonText] = useState(value.lon.toFixed(4));

  // Keep inputs in sync when a site is picked elsewhere (e.g. quick picks).
  useEffect(() => {
    setLatText(value.lat.toFixed(4));
    setLonText(value.lon.toFixed(4));
  }, [value.lat, value.lon]);

  const lat = parseLat(latText);
  const lon = parseLon(lonText);
  const valid = lat !== null && lon !== null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (lat !== null && lon !== null) onNext({ lat, lon });
  }

  return (
    <form className="coord-bar" onSubmit={submit} aria-label="Landing point coordinates">
      <label className="field">
        <span className="eyebrow">Lat</span>
        <input
          inputMode="decimal"
          value={latText}
          onChange={(e) => setLatText(e.target.value)}
          aria-invalid={lat === null}
          aria-describedby="coord-error"
        />
      </label>
      <label className="field">
        <span className="eyebrow">Lon</span>
        <input
          inputMode="decimal"
          value={lonText}
          onChange={(e) => setLonText(e.target.value)}
          aria-invalid={lon === null}
          aria-describedby="coord-error"
        />
      </label>
      <div className="coord-bar__readout">
        <span className="eyebrow">Elev</span>
        <span className="value muted" title="Comes from the LOLA DEM once terrain data is wired in">
          — m
        </span>
      </div>
      <button type="submit" className="btn btn--primary btn--lg" disabled={!valid}>
        Next →
      </button>
      <span id="coord-error" className="error" role="alert" style={{ flexBasis: '100%', textAlign: 'center' }}>
        {lat === null ? 'Latitude must be between −90 and 90. ' : ''}
        {lon === null ? 'Longitude must be between −180 and 360.' : ''}
      </span>
    </form>
  );
}
