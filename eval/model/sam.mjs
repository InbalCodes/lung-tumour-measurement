/**
 * MedSAM (ONNX) on a CT slice, with the same runtime family the browser would use (ONNX Runtime).
 * Shared by the experiment scripts in this folder. Nothing here is used by the tool yet.
 */
import * as ort from 'onnxruntime-node';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SIZE = 1024;
export const WINDOWS = { lung: [-1350, 150], soft: [-160, 240] };

export function loadCase(crops, name) {
  const meta = JSON.parse(readFileSync(join(crops, `${name}.json`), 'utf8'));
  const [nz, ny, nx] = meta.shape;
  const raw = readFileSync(join(crops, `${name}.i16`));
  const hu = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const ref = new Uint8Array(readFileSync(join(crops, `${name}.u8`)));
  return { name, meta, nz, ny, nx, hu, ref, dz: meta.spacing[0], dy: meta.spacing[1], dx: meta.spacing[2] };
}

/** One slice, windowed to 0..255, resized (bilinear) so its longer side is 1024, zero padded, HWC x3. */
export function sliceImage(c, z, window, unit) {
  const [lo, hi] = WINDOWS[window];
  const scale = SIZE / Math.max(c.ny, c.nx);
  const img = new Float32Array(SIZE * SIZE * 3);
  const h = Math.round(c.ny * scale), w = Math.round(c.nx * scale), off = z * c.ny * c.nx;
  const top = unit ? 1 : 255;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(c.ny - 1, Math.max(0, (y + 0.5) / scale - 0.5)), y0 = Math.floor(sy), y1 = Math.min(c.ny - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(c.nx - 1, Math.max(0, (x + 0.5) / scale - 0.5)), x0 = Math.floor(sx), x1 = Math.min(c.nx - 1, x0 + 1), fx = sx - x0;
      const v = (c.hu[off + y0 * c.nx + x0] * (1 - fx) + c.hu[off + y0 * c.nx + x1] * fx) * (1 - fy)
        + (c.hu[off + y1 * c.nx + x0] * (1 - fx) + c.hu[off + y1 * c.nx + x1] * fx) * fy;
      const g = Math.min(1, Math.max(0, (v - lo) / (hi - lo))) * top, i = (y * SIZE + x) * 3;
      img[i] = g; img[i + 1] = g; img[i + 2] = g;
    }
  }
  return { img, scale };
}

export async function openModel(weights, cacheDir, { quantDecoder = false } = {}) {
  const opt = { intraOpNumThreads: 2, graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false };
  const encoder = await ort.InferenceSession.create(join(weights, 'medsam_vit_b.encoder.quant.onnx'), opt);
  const decoder = await ort.InferenceSession.create(join(weights, quantDecoder ? 'medsam_vit_b.decoder.quant.onnx' : 'medsam_vit_b.decoder.onnx'), opt);
  mkdirSync(cacheDir, { recursive: true });
  const stats = { encodes: 0, encodeMs: 0, decodes: 0, decodeMs: 0 };

  async function embed(c, z, window = 'soft', unit = false) {
    const file = join(cacheDir, `${c.name}.${z}.${window}${unit ? '.unit' : ''}.f32`);
    if (existsSync(file)) { const b = readFileSync(file); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
    const { img } = sliceImage(c, z, window, unit), t = Date.now();
    const out = await encoder.run({ input_image: new ort.Tensor('float32', img, [SIZE, SIZE, 3]) });
    stats.encodes++; stats.encodeMs += Date.now() - t;
    const e = out.image_embeddings.data;
    writeFileSync(file, Buffer.from(e.buffer, e.byteOffset, e.byteLength));
    return e;
  }

  /** box = [x0, y0, x1, y1] in slice pixels. Returns a ny*nx Uint8Array mask. */
  async function segment(c, z, box, window = 'soft', unit = false) {
    const e = await embed(c, z, window, unit), scale = SIZE / Math.max(c.ny, c.nx), t = Date.now();
    const p = (v) => (v + 0.5) * scale - 0.5;
    const out = await decoder.run({
      image_embeddings: new ort.Tensor('float32', e, [1, 256, 64, 64]),
      point_coords: new ort.Tensor('float32', Float32Array.from([p(box[0]), p(box[1]), p(box[2]), p(box[3])]), [1, 2, 2]),
      point_labels: new ort.Tensor('float32', Float32Array.from([2, 3]), [1, 2]),
      mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
      has_mask_input: new ort.Tensor('float32', Float32Array.from([0]), [1]),
      orig_im_size: new ort.Tensor('float32', Float32Array.from([SIZE, SIZE]), [2]),
    });
    stats.decodes++; stats.decodeMs += Date.now() - t;
    // The exported decoder's own upscaling has an image size baked in from tracing (it stretches
    // rows by 1.5), so the 256x256 low-resolution logits are upsampled here instead.
    const low = out.low_res_masks.data, L = 256, mask = new Uint8Array(c.ny * c.nx);
    const q = (v) => Math.min(L - 1, Math.max(0, (p(v) + 0.5) / 4 - 0.5));
    for (let y = 0; y < c.ny; y++) { const sy = q(y), y0 = Math.floor(sy), y1 = Math.min(L - 1, y0 + 1), fy = sy - y0;
      for (let x = 0; x < c.nx; x++) { const sx = q(x), x0 = Math.floor(sx), x1 = Math.min(L - 1, x0 + 1), fx = sx - x0;
        const v = (low[y0 * L + x0] * (1 - fx) + low[y0 * L + x1] * fx) * (1 - fy) + (low[y1 * L + x0] * (1 - fx) + low[y1 * L + x1] * fx) * fy;
        if (v > 0) mask[y * c.nx + x] = 1; } }
    return mask;
  }
  return { embed, segment, stats };
}

export function bbox(mask, ny, nx, off = 0) {
  let x0 = nx, y0 = ny, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (mask[off + y * nx + x]) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return n ? { box: [x0, y0, x1, y1], n } : null;
}
export const pad = (b, m, ny, nx) => [Math.max(0, b[0] - m), Math.max(0, b[1] - m), Math.min(nx - 1, b[2] + m), Math.min(ny - 1, b[3] + m)];
export function dice2(a, b, offA = 0, offB = 0, n = a.length) { let i = 0, sa = 0, sb = 0; for (let k = 0; k < n; k++) { const x = a[offA + k], y = b[offB + k]; if (x) sa++; if (y) sb++; if (x && y) i++; } return sa + sb ? 2 * i / (sa + sb) : 1; }
