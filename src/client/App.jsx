import { NavLink, Route, Routes, useLocation } from 'react-router';
import FilterBar from './components/FilterBar.jsx';
import Overview from './pages/Overview.jsx';
import Products from './pages/Products.jsx';
import ProductDetail from './pages/ProductDetail.jsx';
import Orders from './pages/Orders.jsx';
import Returns from './pages/Returns.jsx';
import PnL from './pages/PnL.jsx';
import Inventory from './pages/Inventory.jsx';
import TaxCredits from './pages/TaxCredits.jsx';
import Import from './pages/Import.jsx';
import DataHealth from './pages/DataHealth.jsx';
import AskAI from './pages/AskAI.jsx';
import Settings from './pages/Settings.jsx';
import { useApi } from './lib/api.js';

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/products', label: 'Products' },
  { to: '/orders', label: 'Orders' },
  { to: '/returns', label: 'Returns' },
  { to: '/pnl', label: 'P&L' },
  { to: '/inventory', label: 'Stock' },
  { to: '/tax', label: 'TCS & TDS' },
  { section: 'Data' },
  { to: '/import', label: 'Import files' },
  { to: '/health', label: 'Data health' },
  { to: '/ask', label: 'Ask AI' },
  { to: '/settings', label: 'Settings' },
];

// Pages whose content is scoped by the date/platform filters.
const FILTERED = ['/', '/products', '/orders', '/returns', '/pnl', '/tax'];

export default function App() {
  const { pathname } = useLocation();
  const showFilters = FILTERED.includes(pathname) || pathname.startsWith('/products/');
  const { data: health } = useApi('/reports/health');
  const problems = health
    ? health.unknownCodes.length + health.codesWithoutCost.length + (health.integrity.ok ? 0 : 1)
    : 0;

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-52 shrink-0 border-r border-line bg-surface px-3 py-4 md:block">
        <div className="mb-5 px-2">
          <div className="text-sm font-semibold text-ink">Seller Analytics</div>
          <div className="text-xs text-muted">Flipkart · Shopsy · Meesho</div>
        </div>
        <nav className="space-y-0.5">
          {NAV.map((n) =>
            n.section ? (
              <div key={n.section} className="px-2 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wide text-muted">
                {n.section}
              </div>
            ) : (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `flex items-center justify-between rounded-md px-2 py-1.5 text-sm ${isActive ? 'bg-wash font-medium text-ink' : 'text-ink-2 hover:bg-wash'}`
                }
              >
                {n.label}
                {n.to === '/health' && problems > 0 && (
                  <span className="rounded-full bg-bad px-1.5 text-[11px] font-semibold text-white" title="Items need attention">
                    {problems}
                  </span>
                )}
              </NavLink>
            ),
          )}
        </nav>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-5 md:px-8">
        <nav className="mb-4 flex gap-1 overflow-x-auto md:hidden">
          {NAV.filter((n) => n.to).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `whitespace-nowrap rounded-md px-2 py-1 text-sm ${isActive ? 'bg-wash text-ink' : 'text-ink-2'}`}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        {showFilters && <FilterBar />}
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/products" element={<Products />} />
          <Route path="/products/:id" element={<ProductDetail />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/returns" element={<Returns />} />
          <Route path="/pnl" element={<PnL />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/tax" element={<TaxCredits />} />
          <Route path="/import" element={<Import />} />
          <Route path="/health" element={<DataHealth />} />
          <Route path="/ask" element={<AskAI />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
