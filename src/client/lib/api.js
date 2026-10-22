import { useCallback, useEffect, useRef, useState } from 'react';

export async function api(path, { method = 'GET', body, form } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: form ? undefined : body ? { 'Content-Type': 'application/json' } : undefined,
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function qs(filters, extra = {}) {
  const p = new URLSearchParams();
  if (filters.from) p.set('from', filters.from);
  if (filters.to) p.set('to', filters.to);
  if (filters.platforms?.length) p.set('platforms', filters.platforms.join(','));
  if (filters.categoryId) p.set('categoryId', filters.categoryId);
  for (const [k, v] of Object.entries(extra)) if (v != null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/**
 * Fetch on mount and whenever `path` changes. While a refetch runs the previous data
 * stays on screen (the page dims it) — no skeleton flash, no layout jump.
 */
export function useApi(path) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    api(path)
      .then((data) => mine === seq.current && setState({ data, error: null, loading: false }))
      .catch((err) => mine === seq.current && setState((s) => ({ ...s, error: err.message, loading: false })));
  }, [path]);
  useEffect(() => {
    if (path) load();
  }, [path, load]);
  return { ...state, reload: load };
}
