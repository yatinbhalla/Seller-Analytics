import { useState } from 'react';
import { api, useApi } from '../lib/api.js';
import { useFilters } from '../lib/filters.jsx';
import { shiftDays, today } from '../lib/format.js';
import { Button, Card, Empty, ErrorBox, Input, PageHeader, Status } from '../components/ui.jsx';

const SUGGESTIONS = [
  'Which products should I stop selling on Flipkart, and why?',
  'Why are returns high this month? Which product and reason drive them?',
  'Compare Meesho and Flipkart profit per unit for the wall hanging organizers.',
  'What should I restock this week?',
];

/**
 * Gemini answers from the app's own metric functions — it never sees raw orders or
 * buyer data, and every number it quotes came from the same calculations as the
 * dashboard.
 */
export default function AskAI() {
  const status = useApi('/ai/status');
  const { filters } = useFilters();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [digest, setDigest] = useState(null);
  const [themes, setThemes] = useState(null);

  if (status.data && !status.data.configured) {
    return (
      <>
        <PageHeader title="Ask AI" />
        <Card>
          <Status kind="info">Add your Gemini key to use AI insights.</Status>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-ink-2">
            <li>Get a free key at <a className="text-series underline" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">aistudio.google.com/app/apikey</a>.</li>
            <li>Open <code className="font-mono">.env</code> in the app's folder and set <code className="font-mono">GEMINI_API_KEY=your key</code>.</li>
            <li>Restart the app (close the window and double-click <code className="font-mono">start.bat</code>).</li>
          </ol>
          <p className="mt-3 text-xs text-muted">Everything else in the app works without it.</p>
        </Card>
      </>
    );
  }

  const send = async (text) => {
    const message = (text ?? input).trim();
    if (!message) return;
    setInput('');
    setError(null);
    const next = [...messages, { role: 'user', text: message }];
    setMessages(next);
    setBusy(true);
    try {
      const res = await api('/ai/ask', { method: 'POST', body: { message, history: messages } });
      setMessages([...next, { role: 'model', text: res.text, tools: res.toolsUsed }]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const range = { from: filters.from || shiftDays(today(), -29), to: filters.to || today() };
  const runDigest = async () => {
    setError(null);
    setBusy(true);
    try {
      setDigest(await api('/ai/digest', { method: 'POST', body: range }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const runThemes = async () => {
    setError(null);
    setBusy(true);
    try {
      setThemes(await api('/ai/return-themes', { method: 'POST', body: range }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="Ask AI" subtitle="Answers are worked out from the same numbers as the dashboard. Only totals and product names are sent to Gemini — never buyer details." />
      <ErrorBox error={error} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card title="Ask a question">
          <div className="max-h-[32rem] space-y-3 overflow-y-auto">
            {!messages.length && (
              <div className="space-y-1.5">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)} className="block w-full rounded-md border border-line px-3 py-2 text-left text-sm text-ink-2 hover:bg-wash">{s}</button>
                ))}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'ml-10 rounded-md bg-wash px-3 py-2 text-sm' : 'mr-4 text-sm'}>
                <div className="whitespace-pre-wrap text-ink">{m.text}</div>
                {m.tools?.length > 0 && <div className="mt-1 text-[11px] text-muted">From: {[...new Set(m.tools.map((t) => t.name))].join(', ')}</div>}
              </div>
            ))}
            {busy && <div className="text-sm text-muted">Thinking…</div>}
          </div>
          <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about products, returns, platforms, stock…" className="flex-1" />
            <Button variant="primary" disabled={busy}>Ask</Button>
          </form>
        </Card>

        <div className="space-y-4">
          <Card title="Insight digest" action={<Button onClick={runDigest} disabled={busy}>Run</Button>}>
            <p className="mb-2 text-xs text-muted">{range.from} to {range.to}, against the period before it.</p>
            {!digest ? <Empty>Run it for a summary of what changed and what to do.</Empty> : (
              <div className="space-y-3 text-sm">
                <p className="font-medium text-ink">{digest.headline}</p>
                <Section title="What changed" items={digest.changes} render={(c) => `${c.direction === 'up' ? '▲' : c.direction === 'down' ? '▼' : '•'} ${c.text}`} />
                <Section title="Needs attention" items={digest.attention} render={(a) => [a.product, a.platform].filter(Boolean).join(' · ') + (a.product || a.platform ? ': ' : '') + a.issue} />
                <Section title="Suggested actions" items={digest.actions} render={(a) => `${a.action.toUpperCase()} ${[a.product, a.platform].filter(Boolean).join(' on ')} — ${a.why}`} />
              </div>
            )}
          </Card>
          <Card title="Return-reason themes" action={<Button onClick={runThemes} disabled={busy}>Run</Button>}>
            {!themes ? <Empty>Groups return reasons and buyer comments into themes, per product.</Empty> : (
              <ul className="space-y-2 text-sm">
                {(themes.themes || []).map((t) => (
                  <li key={t.theme}>
                    <div className="font-medium text-ink">{t.theme} <span className="text-muted">({t.count})</span></div>
                    <div className="text-xs text-ink-2">{(t.products || []).map((p) => `${p.product} (${p.count})`).join(', ')}</div>
                    {t.fix && <div className="text-xs text-ink-2">Fix: {t.fix}</div>}
                  </li>
                ))}
                {themes.note && <li className="text-ink-2">{themes.note}</li>}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Section({ title, items, render }) {
  if (!items?.length) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted">{title}</div>
      <ul className="space-y-1">{items.map((x, i) => <li key={i} className="text-ink-2">{render(x)}</li>)}</ul>
    </div>
  );
}
