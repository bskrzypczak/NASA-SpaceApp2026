import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { Placeholder } from '../components/Placeholder';
import { useSelection } from '../store/selection';
import { formatLat, formatLon, toQuery } from '../lib/coords';

/** Screen 4 — confirmation popup over the Site screen. Route: /site/confirm */
export function SiteConfirmModal() {
  const navigate = useNavigate();
  const { lat, lon, name } = useSelection();
  const close = useCallback(() => navigate(`/site${toQuery({ lat, lon })}`), [navigate, lat, lon]);

  return (
    <Modal
      eyebrow="Step 2 of 2 · review"
      title="Confirm your mission"
      onClose={close}
      footer={
        <>
          <button type="button" className="btn btn--lg" onClick={close}>
            Back
          </button>
          <button type="button" className="btn btn--primary btn--lg" disabled title="Simulation screen comes next">
            ▶ Run simulation (next sprint)
          </button>
        </>
      }
    >
      <Placeholder
        label="Route map Earth → Moon"
        note="KSC → TLI → coast → lunar orbit → descent, with time and distance on each leg, plus the low-energy alternative."
        tag="RouteMap · next"
        minHeight={360}
        style={{ flex: '999 1 520px' }}
      />
      <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <dl className="details">
          <div>
            <dt>Landing site</dt>
            <dd>{name ?? 'Custom point'}</dd>
          </div>
          <div>
            <dt>Latitude</dt>
            <dd>{formatLat(lat, 4)}</dd>
          </div>
          <div>
            <dt>Longitude</dt>
            <dd>{formatLon(lon, 4)}</dd>
          </div>
          <div>
            <dt>Landing date</dt>
            <dd className="muted">[from MissionForm]</dd>
          </div>
          <div>
            <dt>Mission length</dt>
            <dd className="muted">[from MissionForm]</dd>
          </div>
        </dl>
        <Placeholder label="Hardware preset" note="Battery, solar array, loads." tag="HardwarePreset · next" minHeight={100} />
      </div>
    </Modal>
  );
}
