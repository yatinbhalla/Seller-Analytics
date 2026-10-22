import { PRESETS, useFilters } from '../lib/filters.jsx';
import { PLATFORMS } from '../lib/format.js';
import { useApi } from '../lib/api.js';
import { Input, Select } from './ui.jsx';

/** One row above the content it scopes: date range first, then platforms, then category. */
export default function FilterBar() {
  const { filters, setFilters } = useFilters();
  const { data: categories } = useApi('/catalog/categories');

  const togglePlatform = (key) => {
    const set = new Set(filters.platforms);
    set.has(key) ? set.delete(key) : set.add(key);
    setFilters({ ...filters, platforms: [...set] });
  };

  return (
    <div className="mb-5 flex flex-wrap items-center gap-2 border-b border-line pb-4">
      <Select
        aria-label="Date range"
        value={filters.preset}
        onChange={(e) => {
          const preset = PRESETS.find((p) => p.key === e.target.value);
          if (preset) {
            const [from, to] = preset.range();
            setFilters({ ...filters, preset: preset.key, from, to });
          } else {
            setFilters({ ...filters, preset: 'custom' });
          }
        }}
      >
        {PRESETS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
        <option value="custom">Custom range…</option>
      </Select>
      {filters.preset === 'custom' && (
        <>
          <Input type="date" aria-label="From" value={filters.from || ''} onChange={(e) => setFilters({ ...filters, from: e.target.value || null })} />
          <span className="text-sm text-muted">to</span>
          <Input type="date" aria-label="To" value={filters.to || ''} onChange={(e) => setFilters({ ...filters, to: e.target.value || null })} />
        </>
      )}

      <div className="ml-2 flex items-center gap-1" role="group" aria-label="Platforms">
        <button
          onClick={() => setFilters({ ...filters, platforms: [] })}
          className={`rounded-md border px-2.5 py-1.5 text-sm ${!filters.platforms.length ? 'border-ink bg-raised font-medium text-ink' : 'border-line text-ink-2 hover:bg-wash'}`}
        >
          All platforms
        </button>
        {PLATFORMS.map((p) => {
          const on = filters.platforms.includes(p.key);
          return (
            <button
              key={p.key}
              aria-pressed={on}
              onClick={() => togglePlatform(p.key)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm ${on ? 'border-ink bg-raised font-medium text-ink' : 'border-line text-ink-2 hover:bg-wash'}`}
            >
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} />
              {p.label}
              {on && <span aria-hidden>✓</span>}
            </button>
          );
        })}
      </div>

      <Select
        aria-label="Category"
        className="ml-2"
        value={filters.categoryId || ''}
        onChange={(e) => setFilters({ ...filters, categoryId: e.target.value ? Number(e.target.value) : null })}
      >
        <option value="">All categories</option>
        {(categories || []).map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
