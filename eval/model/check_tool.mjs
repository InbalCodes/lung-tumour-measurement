/**
 * Check that the tool's own steps (app/src/core/boxes.ts) give the same kind of result as the
 * experiment: five boxes taken from the expert's outline, run exactly as the browser runs them.
 *
 *   node check_tool.mjs <case> [<case> ...]
 *   node check_tool.mjs --split test [--budget seconds]     every scan of the split; finished scans
 *                                                           are kept in data/derived/model/tool_<split>.json,
 *                                                           so a run that hits the budget can be started again
 */
import * as ort from 'onnxruntime-node';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bbox, dice2, loadCase } from './sam.mjs';

const here = process.env.HERE ?? dirname(fileURLToPath(import.meta.url)), core = process.env.CORE_DIR ?? join(here, '..', '..', 'app', 'src', 'core');
const B = await import(join(core, 'boxes.ts')), { measure } = await import(join(core, 'measure.ts')), { cropMask } = await import(join(core, 'volume.ts'));
const data = process.env.DATA ?? join(here, '..', '..', 'data', 'derived'), weights = process.env.WEIGHTS ?? join(here, 'weights');
const opt = { intraOpNumThreads: 2, enableCpuMemArena: false, enableMemPattern: false };
const enc = await ort.InferenceSession.create(join(weights, 'medsam_vit_b.encoder.quant.onnx'), opt), dec = await ort.InferenceSession.create(join(weights, 'medsam_vit_b.decoder.onnx'), opt);

const argv = process.argv.slice(2), opt2 = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const split = opt2('split', ''), budget = Number(opt2('budget', '1e9')) * 1000, started = Date.now();
let names = argv.filter((a, i) => !a.startsWith('--') && !(i && argv[i - 1].startsWith('--')));
if (split) {
  const patients = new Set(JSON.parse(readFileSync(join(here, '..', 'reference', 'splits.json'), 'utf8'))[split]);
  names = readdirSync(join(data, 'crops')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((n) => patients.has(n.split('_')[0])).sort();
}
mkdirSync(join(data, 'model'), { recursive: true });
const keep = join(data, 'model', `tool_${split || 'cases'}.json`), done = split && existsSync(keep) ? JSON.parse(readFileSync(keep, 'utf8')) : {};
let slowest = 40000;
for (const name of names) {
  if (done[name]) continue;
  if (Date.now() - started + slowest * 1.05 > budget) { console.log(`OUT OF TIME: ${Object.keys(done).length} of ${names.length} scans done; run again to continue`); process.exit(0); }
  const caseStart = Date.now();
  const c = loadCase(join(data, 'crops'), name), plane = c.ny * c.nx;
  const v = { hu: c.hu, nz: c.nz, ny: c.ny, nx: c.nx, dz: c.dz, dy: c.dy, dx: c.dx, sliceNumbers: c.meta.instance_numbers, origin: [0, 0], zPositions: c.meta.instance_numbers.map((_, i) => i * c.dz), meta: {} };
  const zs = []; for (let z = 0; z < c.nz; z++) if (bbox(c.ref, c.ny, c.nx, z * plane)) zs.push(z);
  const keys = [...new Set(Array.from({ length: 5 }, (_, i) => zs[Math.round(i * (zs.length - 1) / 4)]))];
  const boxes = B.sortBoxes(keys.map((z) => { const b = bbox(c.ref, c.ny, c.nx, z * plane).box; return { z, x0: b[0] - 2, y0: b[1] - 2, x1: b[2] + 2, y1: b[3] + 2 }; }));
  const roi = B.roiFor(v, boxes), mask = B.regionMask(v, boxes, roi), run = B.modelSlices(boxes), t0 = Date.now();
  for (const z of run) {
    const { image_embeddings } = await enc.run({ input_image: new ort.Tensor('float32', B.sliceInput(v, z, roi), [1024, 1024, 3]) });
    const out = await dec.run({ image_embeddings, point_coords: new ort.Tensor('float32', B.modelBox(B.boxAt(boxes, z), roi), [1, 2, 2]), point_labels: new ort.Tensor('float32', Float32Array.from([2, 3]), [1, 2]),
      mask_input: new ort.Tensor('float32', new Float32Array(65536), [1, 1, 256, 256]), has_mask_input: new ort.Tensor('float32', Float32Array.from([0]), [1]), orig_im_size: new ort.Tensor('float32', Float32Array.from([1024, 1024]), [2]) });
    B.writeSlice(mask, z, out.low_res_masks.data, roi);
  }
  B.fillSkipped(mask, run);
  const full = new Uint8Array(c.nz * plane);
  for (let z = 0; z < mask.nz; z++) for (let y = 0; y < mask.ny; y++) full.set(mask.data.subarray((z * mask.ny + y) * mask.nx, (z * mask.ny + y + 1) * mask.nx), ((z + mask.z0) * c.ny + y + mask.y0) * c.nx + mask.x0);
  const m = measure(cropMask(mask), v), e = measure({ data: c.ref, z0: 0, y0: 0, x0: 0, nz: c.nz, ny: c.ny, nx: c.nx }, v);
  done[name] = { slices: zs.length, throughModel: run.length, seconds: Math.round((Date.now() - t0) / 1000), dice: +dice2(full, c.ref).toFixed(3),
    volumePct: +(100 * (m.volumeMm3 - e.volumeMm3) / e.volumeMm3).toFixed(1), volumeMm3: Math.round(m.volumeMm3), expertVolumeMm3: Math.round(e.volumeMm3),
    long: m.longAxisMm, expertLong: e.longAxisMm, short: m.shortAxisMm, expertShort: e.shortAxisMm };
  writeFileSync(keep, JSON.stringify(done, null, 1));
  slowest = Math.max(slowest, Date.now() - caseStart);
  console.log(name, JSON.stringify(done[name]));
}
if (split) console.log(`DONE: ${Object.keys(done).length} of ${names.length} scans`);
