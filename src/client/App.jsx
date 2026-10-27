import { NavLink, Route, Routes, useLocation } from 'react-router';
import FilterBar from './components/FilterBar.jsx';
import { Tabs } from './components/ui.jsx';
import Overview from './pages/Overview.jsx';
import Payments from './pages/Payments.jsx';
import MoneyToCome from './pages/MoneyToCome.jsx';
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
import Alerts from './pages/Alerts.jsx';
import Customers from './pages/Customers.jsx';
import CustomerDetail from './pages/CustomerDetail.jsx';
import { useApi } from './lib/api.js';
import { AREAS, areaOf } from './lib/areas.jsx';

// Pages whose content is scoped by the date/platform filters.
const FILTERED = ['/', '/payments', '/payments/due', '/pnl', '/tax', '/alerts', '/products', '/orders', '/customers', '/returns'];

export default function App() {
  const { pathname } = useLocation();
  const area = areaOf(pathname);
  const showFilters = FILTERED.includes(pathname) || pathname.startsWith('/products/');
  const { data: health } = useApi('/reports/health');
  const { data: alerts } = useApi('/reports/alerts');
  const problems = health
    ? health.unknownCodes.length + health.codesWithoutCost.length + (health.integrity.ok ? 0 : 1)
    : 0;
  const badges = { data: problems, alerts: alerts ? alerts.counts.high : 0 };

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-52 shrink-0 border-r border-line bg-surface px-3 py-4 md:block">
        <div className="mb-5 flex items-center gap-2 px-2">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <div>
            <div className="text-sm font-semibold text-ink">Seller Analytics</div>
            <div className="text-xs text-muted">Flipkart · Shopsy · Meesho</div>
          </div>
        </div>
        <nav className="space-y-0.5">
          {AREAS.map((a) => (
            <NavLink
              key={a.key}
              to={a.to}
              className={`flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm ${a === area ? `${a.active} font-medium` : 'text-ink-2 hover:bg-wash'}`}
            >
              <a.Icon className={`h-4 w-4 ${a === area ? '' : a.icon}`} />
              {a.label}
              {badges[a.key] > 0 && (
                <span className="ml-auto rounded-full bg-red-600 px-1.5 text-[11px] font-semibold text-white" title={a.key === 'alerts' ? 'High-priority alerts' : 'Items need attention'}>
                  {badges[a.key]}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-5 md:px-8">
        <nav className="mb-4 flex gap-1 overflow-x-auto md:hidden">
          {AREAS.map((a) => (
            <NavLink key={a.key} to={a.to} className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1 text-sm ${a === area ? a.active : 'text-ink-2'}`}>
              <a.Icon className={`h-4 w-4 ${a === area ? '' : a.icon}`} />
              {a.label}
            </NavLink>
          ))}
        </nav>
        {area.tabs && <Tabs items={area.tabs} bar={area.bar} />}
        {showFilters && <FilterBar />}
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/payments" element={<Payments />} />
          <Route path="/payments/due" element={<MoneyToCome />} />
          <Route path="/pnl" element={<PnL />} />
          <Route path="/tax" element={<TaxCredits />} />
          <Route path="/products" element={<Products />} />
          <Route path="/products/:id" element={<ProductDetail />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/returns" element={<Returns />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/customers/:key" element={<CustomerDetail />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/ask" element={<AskAI />} />
          <Route path="/import" element={<Import />} />
          <Route path="/health" element={<DataHealth />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
