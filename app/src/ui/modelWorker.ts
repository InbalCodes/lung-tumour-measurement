/// <reference lib="webworker" />
/**
 * Runs the image model off the main thread, so the viewer stays responsive while it works.
 * The model files are downloaded once from the site and kept in the browser's cache; the scan
 * itself never leaves this computer.
 */
import * as ort from 'onnxruntime-web/wasm';

export type ModelRequest =
  | { type: 'load'; modelBase: string; runtimeBase: string }
  | { type: 'slice'; id: number; image: Float32Array; box: Float32Array };
export type ModelReply =
  | { type: 'progress'; megabytes: number; total: number }
  | { type: 'ready'; threads: number }
  | { type: 'mask'; id: number; low: Float32Array; ms: number }
  | { type: 'error'; id?: number; message: string };

const FILES = [{ name: 'medsam_vit_b.encoder.quant.onnx', megabytes: 109 }, { name: 'medsam_vit_b.decoder.onnx', megabytes: 17 }];
const SIZE = 1024;
let encoder: ort.InferenceSession | null = null, decoder: ort.InferenceSession | null = null;
const post = (reply: ModelReply, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(reply, transfer);

async function fetchCached(url: string, onBytes: (n: number) => void): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try { cache = await caches.open('ltm-model-v1'); } catch { /* cache unavailable: download every time */ }
  const hit = await cache?.match(url);
  if (hit) { const b = await hit.arrayBuffer(); onBytes(b.byteLength); return b; }
  const response = await fetch(url);
  // A missing file on a static host can come back as the site's HTML page, so check the type too.
  if (!response.ok || !response.body || (response.headers.get('content-type') ?? '').includes('text/html')) throw new Error('The model files are not available on this site.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); size += value.length; onBytes(value.length); }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  try { await cache?.put(url, new Response(all.slice().buffer, { headers: { 'content-type': 'application/octet-stream' } })); } catch { /* over quota: keep going without caching */ }
  return all.buffer;
}

async function load(modelBase: string, runtimeBase: string) {
  ort.env.wasm.wasmPaths = runtimeBase;
  // More than one thread needs a cross-origin isolated page, which plain static hosting does not give.
  const threads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  ort.env.wasm.numThreads = threads;
  const total = FILES.reduce((s, f) => s + f.megabytes, 0);
  let bytes = 0;
  const buffers: ArrayBuffer[] = [];
  for (const f of FILES) buffers.push(await fetchCached(modelBase + f.name, (n) => { bytes += n; post({ type: 'progress', megabytes: Math.min(total, Math.round(bytes / 1e6)), total }); }));
  const options: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  encoder = await ort.InferenceSession.create(buffers[0], options);
  decoder = await ort.InferenceSession.create(buffers[1], options);
  post({ type: 'ready', threads });
}

async function slice(id: number, image: Float32Array, box: Float32Array) {
  if (!encoder || !decoder) throw new Error('The model is not loaded.');
  const t0 = performance.now();
  const { image_embeddings } = await encoder.run({ input_image: new ort.Tensor('float32', image, [SIZE, SIZE, 3]) });
  const out = await decoder.run({
    image_embeddings,
    point_coords: new ort.Tensor('float32', box, [1, 2, 2]),
    point_labels: new ort.Tensor('float32', Float32Array.from([2, 3]), [1, 2]), // 2 and 3 mark the two corners of a box
    mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor('float32', Float32Array.from([0]), [1]),
    orig_im_size: new ort.Tensor('float32', Float32Array.from([SIZE, SIZE]), [2]),
  });
  const low = Float32Array.from(out.low_res_masks.data as Float32Array);
  post({ type: 'mask', id, low, ms: Math.round(performance.now() - t0) }, [low.buffer]);
}

self.onmessage = (e: MessageEvent<ModelRequest>) => {
  const m = e.data;
  const work = m.type === 'load' ? load(m.modelBase, m.runtimeBase) : slice(m.id, m.image, m.box);
  work.catch((err) => post({ type: 'error', id: m.type === 'slice' ? m.id : undefined, message: err instanceof Error ? err.message : String(err) }));
};
