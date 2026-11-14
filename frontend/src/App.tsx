import { Link, Outlet, Route, Routes } from 'react-router-dom';
import { TopBar } from './components/TopBar';
import { ExplorePage } from './pages/ExplorePage';
import { CatalogPage } from './pages/CatalogPage';
import { SitePage } from './pages/SitePage';
import { SiteConfirmModal } from './pages/SiteConfirmModal';
import { SimulationNewPage, SimulationPage } from './pages/SimulationPage';

function Layout() {
  return (
    <div className="app">
      <TopBar />
      <Outlet />
    </div>
  );
}

function NotFound() {
  return (
    <main className="page">
      <h1 className="hero-title" style={{ fontSize: 36 }}>Lost in space</h1>
      <p className="muted">This page does not exist.</p>
      <Link to="/" className="btn btn--primary" style={{ alignSelf: 'flex-start' }}>
        Back to the Moon
      </Link>
    </main>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<ExplorePage />} />
        <Route path="catalog" element={<CatalogPage />} />
        <Route path="site" element={<SitePage />}>
          <Route path="confirm" element={<SiteConfirmModal />} />
        </Route>
        <Route path="simulation/new" element={<SimulationNewPage />} />
        <Route path="simulation/:id" element={<SimulationPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
