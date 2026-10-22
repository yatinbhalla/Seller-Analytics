import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Ports are derived the same way as the listers so all three can run side by side.
 *
 * Defaults are 5175 (web) and 3003 (API) — 5173/3001 belong to the Meesho lister and
 * 5174/3002 to the Flipkart lister. When a host assigns a web port via PORT, the API
 * follows at PORT + 1. Keep src/server/index.js in step.
 */
const webPort = Number(process.env.PORT) || 5175;
const apiPort =
  Number(process.env.API_PORT) || (process.env.PORT ? webPort + 1 : 3003);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: webPort,
    proxy: { '/api': `http://localhost:${apiPort}` },
  },
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
    // Every test opens its own in-memory database; running files in parallel is safe.
    pool: 'forks',
  },
});
