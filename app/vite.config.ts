import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

/**
 * Development only: lets the page load a downloaded practice series by id
 * (http://localhost:5173/?series=<SeriesInstanceUID>) instead of using the folder picker.
 * It is not part of the built site, which can only read files the user picks.
 */
function practiceData(): Plugin {
  const root = resolve(__dirname, '..', 'data', 'dicom', 'ct');
  return {
    name: 'practice-data',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__practice', (req, res) => {
        const parts = decodeURIComponent((req.url ?? '').split('?')[0]).split('/').filter(Boolean);
        if (parts.some((p) => !/^[\w.-]+$/.test(p) || p.startsWith('.'))) { res.statusCode = 400; return res.end(); }
        const dir = join(root, parts[0] ?? '');
        if (parts.length === 0) {
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify(existsSync(root) ? readdirSync(root) : []));
        }
        if (!existsSync(dir)) { res.statusCode = 404; return res.end(); }
        if (parts.length === 1) {
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify(readdirSync(dir).filter((f) => f.endsWith('.dcm'))));
        }
        const file = join(dir, parts[1]);
        if (!existsSync(file)) { res.statusCode = 404; return res.end(); }
        res.setHeader('Content-Type', 'application/dicom');
        createReadStream(file).pipe(res);
      });
    },
  };
}

// base './' so the built site works from any path (static hosting, or opened from a folder).
export default defineConfig({ plugins: [react(), practiceData()], base: './' });
