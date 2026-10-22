import { createContext, useContext, useEffect, useState } from 'react';
import { shiftDays, today } from './format.js';

/**
 * One set of filters for the whole app: every page, chart and table below the filter
 * bar reads the same slice, so the numbers always agree. Remembered per browser.
 */
const FiltersContext = createContext(null);

export const PRESETS = [
  { key: '7d', label: 'Last 7 days', range: () => [shiftDays(today(), -6), today()] },
  { key: '30d', label: 'Last 30 days', range: () => [shiftDays(today(), -29), today()] },
  { key: '90d', label: 'Last 90 days', range: () => [shiftDays(today(), -89), today()] },
  { key: 'mtd', label: 'This month', range: () => [`${today().slice(0, 7)}-01`, today()] },
  {
    key: 'lm',
    label: 'Last month',
    range: () => {
      const first = `${today().slice(0, 7)}-01`;
      const end = shiftDays(first, -1);
      return [`${end.slice(0, 7)}-01`, end];
    },
  },
  { key: 'all', label: 'All time', range: () => [null, null] },
];

function initial() {
  try {
    const saved = JSON.parse(localStorage.getItem('analytics.filters') || 'null');
    if (saved) {
      const preset = PRESETS.find((p) => p.key === saved.preset);
      const [from, to] = preset ? preset.range() : [saved.from, saved.to];
      return { ...saved, from, to };
    }
  } catch {
    /* storage unavailable — fall through to defaults */
  }
  const [from, to] = PRESETS[1].range();
  return { preset: '30d', from, to, platforms: [], categoryId: null };
}

export function FiltersProvider({ children }) {
  const [filters, setFilters] = useState(initial);
  useEffect(() => {
    try {
      localStorage.setItem('analytics.filters', JSON.stringify(filters));
    } catch {
      /* ignore */
    }
  }, [filters]);
  return <FiltersContext.Provider value={{ filters, setFilters }}>{children}</FiltersContext.Provider>;
}

export function useFilters() {
  return useContext(FiltersContext);
}
