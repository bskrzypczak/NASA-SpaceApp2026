import { Link, NavLink } from 'react-router-dom';
import { useSelection } from '../store/selection';
import { toQuery } from '../lib/coords';
import { useSimulations } from '../store/simulations';

export function TopBar() {
  const lat = useSelection((s) => s.lat);
  const lon = useSelection((s) => s.lon);
  const lastSim = useSimulations((s) => s.lastId);

  const links = [
    { to: '/', label: 'Explore', end: true },
    { to: '/catalog', label: 'Catalog', end: false },
    { to: `/site${toQuery({ lat, lon })}`, label: 'Site', end: false },
    ...(lastSim ? [{ to: `/simulation/${encodeURIComponent(lastSim)}`, label: 'Simulation', end: false }] : []),
    { to: '/dates', label: 'Dates', end: false },
    { to: '/scenarios', label: 'Scenarios', end: false },
  ];

  return (
    <header className="topbar">
      <Link to="/" className="brand" aria-label="HORIZON home">
        <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
          <circle cx="17" cy="17" r="9" fill="#FFFFFF" />
          <ellipse cx="17" cy="17" rx="16" ry="6" fill="none" stroke="#EAFE07" strokeWidth="1.5" transform="rotate(-20 17 17)" />
        </svg>
        <span className="brand__name">HORIZON</span>
        <span className="muted" style={{ fontSize: 14 }}>
          Lunar landing site planner
        </span>
      </Link>
      <nav aria-label="Main" className="nav">
        {links.map((l) => (
          <NavLink key={l.label} to={l.to} end={l.end} className="nav__link">
            {l.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
