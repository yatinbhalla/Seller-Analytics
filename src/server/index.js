import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { getDb, integrityCheck } from './db/db.js';
import { syncCatalog } from './catalog/sync.js';
import apiRouter from './routes/api.js';

/**
 * Port derivation matches vite.config.js and the listers: 3003 unless API_PORT says
 * otherwise, or PORT + 1 when a host assigns the web port.
 */
const webPort = Number(process.env.PORT) || 5175;
const apiPort = Number(process.env.API_PORT) || (process.env.PORT ? webPort + 1 : 3003);

const db = getDb();

// A corrupt database is reported loudly at startup — before any number is shown.
const check = integrityCheck(db);
if (!check.ok) {
  console.error('⚠ Database integrity check FAILED:', check);
  console.error('  Restore the latest backup from Settings → Backups before importing anything.');
} else {
  console.log('✓ Database integrity check passed.');
}

try {
  const r = syncCatalog(db);
  console.log(`✓ Catalog synced from the listers: +${r.products} products, +${r.codes} codes, +${r.costs} costs, +${r.listings} listing SKUs.`);
} catch (err) {
  console.error('⚠ Catalog sync failed:', err.message);
}

const app = express();
// Only the local Vite client talks to this server.
app.use(cors({ origin: [`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`] }));
app.use(express.json({ limit: '2mb' }));
app.get('/api/health', (req, res) => res.json({ ok: true, integrity: integrityCheck(getDb()).ok }));
app.use('/api', apiRouter);

// `npm run build` output, so the app can also run without Vite.
const dist = path.resolve('dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// localhost only: business data never leaves this machine through this server.
app.listen(apiPort, '127.0.0.1', () => {
  console.log(`Seller Analytics API on http://localhost:${apiPort} — open http://localhost:${webPort}`);
});
