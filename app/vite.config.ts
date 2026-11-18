import react from '@vitejs/plugin-react';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync } from 'node:fs';
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

/**
 * The image model runs on ONNX Runtime Web. Its WebAssembly files are copied from the package
 * into public/ort so the site serves them itself and needs no outside service at run time.
 */
function onnxRuntimeFiles(): Plugin {
  return {
    name: 'onnx-runtime-files',
    buildStart() {
      const from = resolve(__dirname, 'node_modules', 'onnxruntime-web', 'dist'), to = resolve(__dirname, 'public', 'ort');
      if (!existsSync(from)) return;
      mkdirSync(to, { recursive: true });
      for (const f of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) copyFileSync(join(from, f), join(to, f));
    },
  };
}

/**
 * Cross-origin isolation lets the image model use several threads; without it one slice takes most
 * of a minute. Every response needs the headers, including the files in public/, so they are added
 * here for the dev and preview servers. On static hosting public/isolate-sw.js does the same job.
 */
function crossOriginIsolation(): Plugin {
  const add = (_req: unknown, res: { setHeader(name: string, value: string): void }, next: () => void) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    next();
  };
  return { name: 'cross-origin-isolation', configureServer(server) { server.middlewares.use(add); }, configurePreviewServer(server) { server.middlewares.use(add); } };
}

// base './' so the built site works from any path (static hosting, or opened from a folder).
export default defineConfig({
  plugins: [react(), practiceData(), onnxRuntimeFiles(), crossOriginIsolation()],
  base: './',
  worker: { format: 'es' },
  // Prepared up front, so the dev server does not reload the page the first time the model is used.
  optimizeDeps: { include: ['onnxruntime-web/wasm'] },
});
