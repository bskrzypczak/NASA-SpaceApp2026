import { MISSION_LENGTHS, useSelection } from '../../store/selection';

/** Landing date/time (UTC) and mission length. Writes to the shared store. */
export function MissionForm() {
  const landingTime = useSelection((s) => s.landingTime);
  const missionDays = useSelection((s) => s.missionDays);
  const setMission = useSelection((s) => s.setMission);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <label className="field">
        <span className="eyebrow">Landing date (UTC)</span>
        <input type="datetime-local" value={landingTime} onChange={(e) => e.target.value && setMission({ landingTime: e.target.value })} />
      </label>
      <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="eyebrow" style={{ paddingBottom: 8 }}>
          Mission length
        </legend>
        <div className="segmented segmented--full" role="group">
          {MISSION_LENGTHS.map((d) => (
            <button key={d} type="button" aria-pressed={missionDays === d} onClick={() => setMission({ missionDays: d })}>
              {d} d
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
