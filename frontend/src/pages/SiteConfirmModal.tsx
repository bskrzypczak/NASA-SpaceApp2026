import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { RouteScene } from '../components/route/RouteScene';
import { LaunchSitePicker } from '../components/route/LaunchSitePicker';
import { useSelection, type TransferType } from '../store/selection';
import { launchSiteById } from '../data/launchSites';
import { TRANSFERS, formatDuration, subtractHours, totalHours } from '../data/route';
import { formatLat, formatLon, toQuery } from '../lib/coords';

/** Screen 4 — confirmation popup over the Site screen. Route: /site/confirm */
export function SiteConfirmModal() {
  const navigate = useNavigate();
  const { lat, lon, name, landingTime, missionDays, launchSiteId, transfer, setMission } = useSelection();
  const close = useCallback(() => navigate(`/site${toQuery({ lat, lon })}`), [navigate, lat, lon]);

  const launch = launchSiteById(launchSiteId);
  const plan = TRANSFERS[transfer];
  const launchTime = subtractHours(landingTime, totalHours(plan));

  return (
    <Modal
      size="xl"
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
      <section className="confirm__route" aria-label="Route from Earth to the landing site">
        <div className="segmented" role="group" aria-label="Transfer type">
          {(Object.keys(TRANSFERS) as TransferType[]).map((t) => (
            <button key={t} type="button" aria-pressed={transfer === t} onClick={() => setMission({ transfer: t })}>
              {TRANSFERS[t].label} · {formatDuration(totalHours(TRANSFERS[t]))}
            </button>
          ))}
        </div>

        <div className="confirm__scene">
          <RouteScene launch={launch} landing={{ lat, lon }} transfer={transfer} onTransferChange={(t) => setMission({ transfer: t })} />
        </div>

        <ol className="confirm__legs">
          {plan.legs.map((l, i) => (
            <li key={l.name}>
              <span className="mono" style={{ color: 'var(--accent)', fontSize: 12 }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <strong>{l.name}</strong>
              <span className="mono muted">{formatDuration(l.hours)}</span>
            </li>
          ))}
        </ol>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Not to scale. 384,400 km is the average Earth–Moon distance; leg times are planning estimates.
        </p>
      </section>

      <section className="confirm__side" aria-label="Mission details">
        <LaunchSitePicker value={launchSiteId} onChange={(id) => setMission({ launchSiteId: id })} />

        <dl className="details">
          <div>
            <dt>Landing site</dt>
            <dd>{name ?? 'Custom point'}</dd>
          </div>
          <div>
            <dt>Coordinates</dt>
            <dd>
              {formatLat(lat, 3)} · {formatLon(lon, 3)}
            </dd>
          </div>
          <div>
            <dt>Launch (UTC)</dt>
            <dd>{launchTime.replace('T', ' ')}</dd>
          </div>
          <div>
            <dt>Landing (UTC)</dt>
            <dd>{landingTime.replace('T', ' ')}</dd>
          </div>
          <div>
            <dt>Surface mission</dt>
            <dd>{missionDays} days</dd>
          </div>
        </dl>
      </section>
    </Modal>
  );
}
