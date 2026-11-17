/**
 * Experiment: can an image model (MedSAM, ONNX) outline the tumours the brightness method gets wrong?
 *
 *   node run.mjs [--split dev] [--cases a,b] [--budget seconds]
 *
 * Three prompts per case, both slice by slice:
 *   oracle  the box around the expert's outline on every slice. Not available in real use; it shows
 *           the best the model can do when told exactly where the tumour is.
 *   box     one box dragged around the tumour on the measurement slice (simulated with the expert's
 *           box on that slice). The outline is carried to the next slice, whose box is the previous
 *           outline's, until it fades into lung, shrinks away, or is too far from the start.
 *   stroke  what the tool has today: one line across the tumour. A square box is built around the
 *           line, the outline is refined once, then carried the same way.
 * Slice embeddings are cached on disk, so a run that hits --budget can simply be started again.
 * Needs: node scripts/dump_outlines.ts <cases> first (stroke and brightness-method result per case).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bbox, dice2, loadCase, openModel, pad } from './sam.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { measure } = await import(process.env.CORE ?? '../../app/src/core/measure.ts');
const data = process.env.DATA ?? join(here, '..', '..', 'data', 'derived');
const weights = process.env.WEIGHTS ?? join(here, 'weights'), cache = process.env.CACHE ?? join(here, 'emb');
const args = process.argv.slice(2), arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const CARRY_PAD = Number(process.env.CARRY_PAD ?? 1), TAG = process.env.TAG ?? '';
const budget = Number(arg('budget', '1e9')) * 1000, started = Date.now(), WINDOW = 'lung';
const out = join(data, 'model'); mkdirSync(out, { recursive: true });
const classical = Object.fromEntries(JSON.parse(readFileSync(join(data, 'tool', 'summary.json'), 'utf8')).map((r) => [r.case, r]));
const cases = arg('cases', '') ? arg('cases', '').split(',') : Object.keys(classical);
const model = await openModel(weights, cache);

class OutOfTime extends Error {}
async function seg(c, z, box) {
  if (!existsSync(join(cache, `${c.name}.${z}.${WINDOW}.f32`)) && Date.now() - started > budget) throw new OutOfTime();
  return model.segment(c, z, box, WINDOW, false);
}
const meanHu = (c, z, m) => { let s = 0, n = 0; for (let i = 0; i < m.length; i++) if (m[i]) { s += c.hu[z * c.ny * c.nx + i]; n++; } return n ? s / n : -1000; };

async function oracle(c) {
  const full = new Uint8Array(c.nz * c.ny * c.nx);
  for (let z = 0; z < c.nz; z++) {
    const b = bbox(c.ref, c.ny, c.nx, z * c.ny * c.nx); if (!b) continue;
    full.set(await seg(c, z, pad(b.box, 2, c.ny, c.nx)), z * c.ny * c.nx);
  }
  return full;
}

/**
 * Boxes on a few slices only (first, last and evenly spaced between; simulated with the expert's
 * boxes there), interpolated linearly for the slices in between.
 */
async function keyframes(c, count) {
  const full = new Uint8Array(c.nz * c.ny * c.nx), zs = [];
  for (let z = 0; z < c.nz; z++) if (bbox(c.ref, c.ny, c.nx, z * c.ny * c.nx)) zs.push(z);
  const keys = [...new Set(Array.from({ length: count }, (_, i) => zs[Math.round(i * (zs.length - 1) / (count - 1))]))];
  const boxes = keys.map((z) => bbox(c.ref, c.ny, c.nx, z * c.ny * c.nx).box);
  for (const z of zs) {
    let i = 0; while (i < keys.length - 2 && z > keys[i + 1]) i++;
    const t = keys.length > 1 ? (z - keys[i]) / (keys[i + 1] - keys[i]) : 0;
    const b = keys.length > 1 ? boxes[i].map((v, j) => Math.round(v + t * (boxes[i + 1][j] - v))) : boxes[0];
    full.set(await seg(c, z, pad(b, 2, c.ny, c.nx)), z * c.ny * c.nx);
  }
  return full;
}

/** The box around the brightness method's own outline on every slice it marked. */
async function hybrid(c) {
  const full = new Uint8Array(c.nz * c.ny * c.nx), tool = new Uint8Array(readFileSync(join(data, 'tool', `${c.name}.u8`)));
  for (let z = 0; z < c.nz; z++) {
    const b = bbox(tool, c.ny, c.nx, z * c.ny * c.nx); if (!b || b.n < 6) continue;
    full.set(await seg(c, z, pad(b.box, 2, c.ny, c.nx)), z * c.ny * c.nx);
  }
  return full;
}

/** Outline on slice z0 from a box, then carried slice by slice in both directions. */
async function carry(c, z0, box0, lenMm, refine) {
  const full = new Uint8Array(c.nz * c.ny * c.nx), plane = c.ny * c.nx;
  let m = await seg(c, z0, box0), b = bbox(m, c.ny, c.nx); if (!b) return full;
  if (refine) { m = await seg(c, z0, pad(b.box, 3, c.ny, c.nx)); b = bbox(m, c.ny, c.nx); if (!b) return full; }
  full.set(m, z0 * plane);
  const area0 = b.n, zCap = Math.ceil(0.75 * lenMm / c.dz);
  for (const dir of [-1, 1]) {
    let prev = b;
    for (let z = z0 + dir; z >= 0 && z < c.nz && Math.abs(z - z0) <= zCap; z += dir) {
      const mk = await seg(c, z, pad(prev.box, CARRY_PAD, c.ny, c.nx)), bk = bbox(mk, c.ny, c.nx);
      if (!bk || bk.n < 0.1 * area0 || bk.n < 6 || meanHu(c, z, mk) < -450) break;
      full.set(mk, z * plane); prev = bk;
    }
  }
  return full;
}

/** A line across the tumour: start from a square box as wide as the line is long, refined once. */
function fromStroke(c, z0, [xa, ya, xb, yb]) {
  const h = Math.hypot(xb - xa, yb - ya) / 2 * 1.1, cx = (xa + xb) / 2, cy = (ya + yb) / 2;
  return carry(c, z0, pad([Math.round(cx - h), Math.round(cy - h), Math.round(cx + h), Math.round(cy + h)], 0, c.ny, c.nx), Math.hypot((xb - xa) * c.dx, (yb - ya) * c.dy), true);
}

/** A box dragged around the tumour on one slice (simulated by the box around the expert's outline there). */
function fromBox(c, z0) {
  const b = bbox(c.ref, c.ny, c.nx, z0 * c.ny * c.nx).box;
  return carry(c, z0, pad(b, 2, c.ny, c.nx), Math.max((b[2] - b[0]) * c.dx, (b[3] - b[1]) * c.dy), false);
}

const results = [];
try {
  for (const name of cases) {
    const c = loadCase(join(data, 'crops'), name), k = classical[name];
    const volume = { hu: c.hu, nz: c.nz, ny: c.ny, nx: c.nx, dz: c.dz, dy: c.dy, dx: c.dx, sliceNumbers: c.meta.instance_numbers, origin: [0, 0],
      zPositions: c.meta.instance_numbers.map((_, i) => i * c.dz), meta: {} };
    const row = { case: name, expert: k.expert, classical: { dice: k.dice, volumePct: k.volumePct, long: k.tool?.long, short: k.tool?.short } };
    for (const [mode, fn] of [['oracle', () => oracle(c)], ['box', () => fromBox(c, k.slice)], ['stroke', () => fromStroke(c, k.slice, k.stroke)], ['hybrid', () => hybrid(c)], ['keys3', () => keyframes(c, 3)], ['keys5', () => keyframes(c, 5)]]) {
      const full = await fn(); writeFileSync(join(out, `${name}.${mode}.u8`), full);
      const mm = measure({ data: full, z0: 0, y0: 0, x0: 0, nz: c.nz, ny: c.ny, nx: c.nx }, volume);
      row[mode] = { dice: +dice2(full, c.ref).toFixed(2), volumePct: Math.round(100 * (mm.volumeMm3 - k.expert.volume) / k.expert.volume), long: mm.longAxisMm, short: mm.shortAxisMm };
    }
    results.push(row); console.log(JSON.stringify(row));
  }
  writeFileSync(join(out, `results${TAG}.json`), JSON.stringify({ window: WINDOW, carryPad: CARRY_PAD, results }, null, 1));
  console.log('DONE', cases.length, 'cases');
} catch (e) { if (!(e instanceof OutOfTime)) throw e; console.log('OUT OF TIME after', results.length, 'cases; run again to continue'); }
const s = model.stats; console.log(`encoded ${s.encodes} slices, ${s.encodes ? Math.round(s.encodeMs / s.encodes) : 0} ms each; ${s.decodes} decodes, ${s.decodes ? Math.round(s.decodeMs / s.decodes) : 0} ms each`);
