import { IconAlerts, IconAsk, IconData, IconHome, IconOrders, IconPayments, IconProducts, IconStock } from '../components/Icons.jsx';

/**
 * The app's eight areas, each with its own colour. An area with tabs groups pages that
 * used to be separate menu entries; every old URL still works and shows its area's tabs.
 * Class names are written out in full so Tailwind finds them.
 */
export const AREAS = [
  {
    key: 'home', to: '/', label: 'Home', end: true, Icon: IconHome, paths: ['/'],
    icon: 'text-indigo-600 dark:text-indigo-400', active: 'bg-indigo-100 text-indigo-950 dark:bg-indigo-950 dark:text-indigo-100', bar: 'border-indigo-500',
  },
  {
    key: 'payments', to: '/payments', label: 'Payments', Icon: IconPayments, paths: ['/payments', '/pnl', '/tax'],
    icon: 'text-green-600 dark:text-green-400', active: 'bg-green-100 text-green-950 dark:bg-green-950 dark:text-green-100', bar: 'border-green-500',
    tabs: [
      { to: '/payments', label: 'Payments', end: true },
      { to: '/pnl', label: 'Profit breakdown' },
      { to: '/payments/due', label: 'Money to come' },
      { to: '/tax', label: 'TCS & TDS' },
    ],
  },
  {
    key: 'products', to: '/products', label: 'Products', Icon: IconProducts, paths: ['/products'],
    icon: 'text-violet-600 dark:text-violet-400', active: 'bg-violet-100 text-violet-950 dark:bg-violet-950 dark:text-violet-100', bar: 'border-violet-500',
  },
  {
    key: 'orders', to: '/orders', label: 'Orders', Icon: IconOrders, paths: ['/orders', '/returns', '/customers'],
    icon: 'text-sky-600 dark:text-sky-400', active: 'bg-sky-100 text-sky-950 dark:bg-sky-950 dark:text-sky-100', bar: 'border-sky-500',
    tabs: [
      { to: '/orders', label: 'Orders' },
      { to: '/returns', label: 'Returns' },
      { to: '/customers', label: 'Customers' },
    ],
  },
  {
    key: 'stock', to: '/inventory', label: 'Stock', Icon: IconStock, paths: ['/inventory'],
    icon: 'text-teal-600 dark:text-teal-400', active: 'bg-teal-100 text-teal-950 dark:bg-teal-950 dark:text-teal-100', bar: 'border-teal-500',
  },
  {
    key: 'alerts', to: '/alerts', label: 'Alerts', Icon: IconAlerts, paths: ['/alerts'],
    icon: 'text-red-600 dark:text-red-400', active: 'bg-red-100 text-red-950 dark:bg-red-950 dark:text-red-100', bar: 'border-red-500',
  },
  {
    key: 'ask', to: '/ask', label: 'Ask AI', Icon: IconAsk, paths: ['/ask'],
    icon: 'text-pink-600 dark:text-pink-400', active: 'bg-pink-100 text-pink-950 dark:bg-pink-950 dark:text-pink-100', bar: 'border-pink-500',
  },
  {
    key: 'data', to: '/import', label: 'Data', Icon: IconData, paths: ['/import', '/health', '/settings'],
    icon: 'text-stone-500 dark:text-stone-400', active: 'bg-stone-200 text-stone-950 dark:bg-stone-800 dark:text-stone-100', bar: 'border-stone-500',
    tabs: [
      { to: '/import', label: 'Import files' },
      { to: '/health', label: 'Data health' },
      { to: '/settings', label: 'Settings' },
    ],
  },
];

/** The area a page belongs to. */
export function areaOf(pathname) {
  if (pathname === '/') return AREAS[0];
  return AREAS.find((a) => a.key !== 'home' && a.paths.some((p) => pathname === p || pathname.startsWith(`${p}/`))) || AREAS[0];
}
