/**
 * Experiment (not part of the tool): how far does a simple automatic search for nodules get?
 *
 *   node scripts/detect_experiment.ts [--split dev|test] [--budget seconds]
 *
 * The scan is reduced to 2 mm voxels. The lungs are found as the air inside the body, their outline
 * is smoothed over so that things attached to the chest wall fall inside it, and every solid blob
 * inside that survives the removal of thin structures (vessels) becomes a candidate mark.
 *
 * Two questions, the ones Daniel asked: is the known tumour among the marks, and how many other
 * marks would he have to look at per scan? The practice data outlines one tumour per scan and
 * nothing else, so the other marks cannot be called right or wrong here; they are counted.
 * Results are kept per scan in data/derived/detect, so a run can be continued.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVolume, parseSlice } from '../src/core/dicom.ts';
import type { ParsedSlice } from '../src/core/dicom.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2), arg = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const split = arg('split', 'dev'), budget = Number(arg('budget', '1e9')) * 1000, started = Date.now();
const cache = join(root, 'data', 'derived', 'detect'); mkdirSync(cache, { recursive: true });
const G = 2, AIR = -400, CLOSE = 5, MAX_CM3 = 150;
/**
 * Settings compared. default: thin structures removed lightly. strict: removed heavily (loses small
 * nodules). combined: see below. A mark more than 2.5 times longer than a ball of its volume is
 * treated as a vessel and dropped.
 */
const VARIANTS = [{ name: 'default', maxElong: 2.5 }, { name: 'strict', maxElong: 2.5 }, { name: 'combined', maxElong: 2.5 }];

const patients: string[] = JSON.parse(readFileSync(join(root, 'eval', 'reference', 'splits.json'), 'utf8'))[split];
const lines = readFileSync(join(root, 'eval', 'reference', 'reference_measurements.csv'), 'utf8').trim().split('\n'), head = lines[0].split(',');
const rows = lines.slice(1).map((l) => Object.fromEntries(l.split(',').map((c, i) => [head[i], c]))).filter((r) => r.outline === 'man' && patients.includes(r.patient_id));

function components(mask: Uint8Array, nz: number, ny: number, nx: number, full: boolean) {
  const label = new Int32Array(mask.length), comps: { voxels: number[] }[] = [], plane = ny * nx, stack: number[] = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s]) continue;
    const voxels: number[] = []; label[s] = comps.length + 1; stack.push(s);
    while (stack.length) {
      const i = stack.pop()!; voxels.push(i);
      const z = Math.floor(i / plane), y = Math.floor((i % plane) / nx), x = i % nx;
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!full && Math.abs(dz) + Math.abs(dy) + Math.abs(dx) !== 1) continue;
        const zz = z + dz, yy = y + dy, xx = x + dx;
        if (zz < 0 || yy < 0 || xx < 0 || zz >= nz || yy >= ny || xx >= nx) continue;
        const j = zz * plane + yy * nx + xx;
        if (mask[j] && !label[j]) { label[j] = comps.length + 1; stack.push(j); }
      }
    }
    comps.push({ voxels });
  }
  return comps;
}

/** Per slice: everything reachable from the slice border through `open` pixels. */
function fromBorder(open: Uint8Array, nz: number, ny: number, nx: number) {
  const out = new Uint8Array(open.length), stack: number[] = [];
  for (let z = 0; z < nz; z++) {
    const b = z * ny * nx, push = (y: number, x: number) => { const i = b + y * nx + x; if (open[i] && !out[i]) { out[i] = 1; stack.push(y * nx + x); } };
    for (let x = 0; x < nx; x++) { push(0, x); push(ny - 1, x); }
    for (let y = 0; y < ny; y++) { push(y, 0); push(y, nx - 1); }
    while (stack.length) { const p = stack.pop()!, y = Math.floor(p / nx), x = p % nx; if (y > 0) push(y - 1, x); if (y < ny - 1) push(y + 1, x); if (x > 0) push(y, x - 1); if (x < nx - 1) push(y, x + 1); }
  }
  return out;
}

function dilate2d(m: Uint8Array, nz: number, ny: number, nx: number, r: number) {
  const out = new Uint8Array(m.length), offs: [number, number][] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) offs.push([dy, dx]);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (!m[(z * ny + y) * nx + x]) continue;
    for (const [dy, dx] of offs) { const yy = y + dy, xx = x + dx; if (yy >= 0 && xx >= 0 && yy < ny && xx < nx) out[(z * ny + yy) * nx + xx] = 1; }
  }
  return out;
}
const invert = (m: Uint8Array) => m.map((v) => (v ? 0 : 1));

function cross3d(m: Uint8Array, nz: number, ny: number, nx: number, grow: boolean) {
  const out = new Uint8Array(m.length), plane = ny * nx;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = z * plane + y * nx + x;
    const n = [z > 0 ? m[i - plane] : 0, z < nz - 1 ? m[i + plane] : 0, y > 0 ? m[i - nx] : 0, y < ny - 1 ? m[i + nx] : 0, x > 0 ? m[i - 1] : 0, x < nx - 1 ? m[i + 1] : 0];
    out[i] = grow ? (m[i] || n.some(Boolean) ? 1 : 0) : (m[i] && n.every(Boolean) ? 1 : 0);
  }
  return out;
}

function run(r: Record<string, string>) {
  const dir = join(root, 'data', 'dicom', 'ct', r.series_uid), slices: ParsedSlice[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.dcm'))) { const b = readFileSync(join(dir, f)); const s = parseSlice(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer); if (s) slices.push(s); }
  const v = buildVolume(slices), t0 = performance.now();
  // 2 mm grid, mean of the voxels that fall in each cell
  const nz = Math.ceil((v.nz * v.dz) / G), ny = Math.ceil((v.ny * v.dy) / G), nx = Math.ceil((v.nx * v.dx) / G), n = nz * ny * nx;
  const sum = new Float32Array(n), cnt = new Uint16Array(n), cell = (z: number, y: number, x: number) => (Math.floor((z * v.dz) / G) * ny + Math.floor((y * v.dy) / G)) * nx + Math.floor((x * v.dx) / G);
  const xi = new Int32Array(v.nx).map((_, x) => Math.floor((x * v.dx) / G));
  for (let z = 0; z < v.nz; z++) for (let y = 0; y < v.ny; y++) { const base = (Math.floor((z * v.dz) / G) * ny + Math.floor((y * v.dy) / G)) * nx, src = (z * v.ny + y) * v.nx; for (let x = 0; x < v.nx; x++) { sum[base + xi[x]] += v.hu[src + x]; cnt[base + xi[x]]++; } }
  const air = new Uint8Array(n); for (let i = 0; i < n; i++) air[i] = cnt[i] && sum[i] / cnt[i] < AIR ? 1 : 0;
  // lungs: air that is not connected to the outside of the body, large pieces only
  const outside = fromBorder(air, nz, ny, nx), inner = air.map((a, i) => (a && !outside[i] ? 1 : 0));
  const pieces = components(inner, nz, ny, nx, false).sort((a, b) => b.voxels.length - a.voxels.length), lung = new Uint8Array(n);
  for (const p of pieces.filter((p, k) => k === 0 || p.voxels.length * G ** 3 > 100000)) for (const i of p.voxels) lung[i] = 1;
  // smooth the lung outline over (closing), then fill what is enclosed
  let closed = invert(dilate2d(invert(dilate2d(lung, nz, ny, nx, CLOSE)), nz, ny, nx, CLOSE));
  for (let i = 0; i < n; i++) if (lung[i]) closed[i] = 1;
  const reach = fromBorder(invert(closed), nz, ny, nx); closed = closed.map((c, i) => (c || !reach[i] ? 1 : 0));
  const dense = closed.map((c, i) => (c && !air[i] ? 1 : 0));
  // the expert's tumour on the same grid
  const meta = JSON.parse(readFileSync(join(root, 'data', 'derived', 'crops', `${r.case}.json`), 'utf8')), [mz, my, mx] = meta.shape, [z0, y0, x0] = meta.offset;
  const refData = new Uint8Array(readFileSync(join(root, 'data', 'derived', 'crops', `${r.case}.u8`))), ref = new Uint8Array(n);
  for (let z = 0; z < mz; z++) for (let y = 0; y < my; y++) for (let x = 0; x < mx; x++) if (refData[(z * my + y) * mx + x]) ref[cell(z + z0, y + y0, x + x0)] = 1;
  const refCells = ref.reduce((s, x) => s + x, 0);
  let refInside = 0; for (let i = 0; i < n; i++) if (ref[i] && closed[i]) refInside++;

  const result: Record<string, unknown> = { case: r.case, expertCm3: +(Number(r.volume_mm3) / 1000).toFixed(1), expertLongMm: Number(r.long_axis_mm), lungLitres: +((lung.reduce((s, x) => s + x, 0) * G ** 3) / 1e6).toFixed(1), tumourInsideSearchArea: +(refInside / refCells).toFixed(2) };
  const erode = (k: number) => { let m = dense; for (let i = 0; i < k; i++) m = cross3d(m, nz, ny, nx, false); return m; };
  const opened = (k: number) => { let m = erode(k); for (let i = 0; i < k; i++) m = cross3d(m, nz, ny, nx, true); return m.map((x, i) => (x && dense[i] ? 1 : 0)); };
  const plane = ny * nx;
  /** Cores that survive heavy thinning, each grown back a few steps on its own, so a nodule and the vessels it touches stay separate marks. */
  const regrown = () => {
    const label = new Int32Array(n), seeds = components(erode(2), nz, ny, nx, false);
    seeds.forEach((c, k) => { for (const i of c.voxels) label[i] = k + 1; });
    for (let step = 0; step < 3; step++) {
      const next = label.slice();
      for (let i = 0; i < n; i++) {
        if (label[i] || !dense[i]) continue;
        const x = i % nx, y = Math.floor((i % plane) / nx), z = Math.floor(i / plane);
        next[i] = (x > 0 && label[i - 1]) || (x < nx - 1 && label[i + 1]) || (y > 0 && label[i - nx]) || (y < ny - 1 && label[i + nx]) || (z > 0 && label[i - plane]) || (z < nz - 1 && label[i + plane]) || 0;
      }
      label.set(next);
    }
    const groups: { voxels: number[] }[] = seeds.map(() => ({ voxels: [] }));
    for (let i = 0; i < n; i++) if (label[i]) groups[label[i] - 1].voxels.push(i);
    return { groups, label };
  };
  const candidates: Record<string, { voxels: number[] }[]> = { default: components(opened(1), nz, ny, nx, true), strict: components(opened(2), nz, ny, nx, true) };
  const big = regrown();
  // combined: the separated large marks, plus small compact ones (up to about 20 mm) that the heavy thinning removed
  candidates.combined = [...big.groups, ...candidates.default.filter((c) => c.voxels.length * G ** 3 <= 4000 && !c.voxels.some((i) => big.label[i]))];
  for (const variant of VARIANTS) {
    const marks = [];
    for (const c of candidates[variant.name]) {
      const mm3 = c.voxels.length * G ** 3; if (mm3 < 100 || mm3 > MAX_CM3 * 1000) continue;
      let zl = nz, zh = 0, yl = ny, yh = 0, xl = nx, xh = 0, hit = 0;
      for (const i of c.voxels) { const z = Math.floor(i / plane), y = Math.floor((i % plane) / nx), x = i % nx; if (z < zl) zl = z; if (z > zh) zh = z; if (y < yl) yl = y; if (y > yh) yh = y; if (x < xl) xl = x; if (x > xh) xh = x; if (ref[i]) hit++; }
      const diameter = Math.cbrt((6 * mm3) / Math.PI), extent = (Math.max(zh - zl, yh - yl, xh - xl) + 1) * G;
      if (extent / diameter > variant.maxElong) continue;
      marks.push({ mm3, diameter: +diameter.toFixed(1), covers: +(hit / refCells).toFixed(2) });
    }
    const onTumour = marks.filter((k) => k.covers > 0), best = Math.max(0, ...onTumour.map((k) => k.covers)), others = marks.filter((k) => k.covers === 0);
    result[variant.name] = { found: best >= 0.2, tumourCovered: best, marks: marks.length, otherMarks: others.length,
      other6to10: others.filter((k) => k.diameter < 10).length, other10to20: others.filter((k) => k.diameter >= 10 && k.diameter < 20).length, other20plus: others.filter((k) => k.diameter >= 20).length };
  }
  result.ms = Math.round(performance.now() - t0);
  return result;
}

const all: any[] = [];
let pending = 0;
for (const r of rows) {
  const file = join(cache, `${r.case}.json`);
  if (existsSync(file)) { all.push(JSON.parse(readFileSync(file, 'utf8'))); continue; }
  if (Date.now() - started > budget) { pending++; continue; }
  const res = run(r); writeFileSync(file, JSON.stringify(res)); all.push(res); console.log(JSON.stringify(res));
}
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y), h = s.length >> 1; return s.length ? (s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2) : NaN; };
const summary: Record<string, unknown> = { split, scans: all.length, pending, msMedian: median(all.map((a) => a.ms)), tumourInsideSearchAreaMedian: median(all.map((a) => a.tumourInsideSearchArea)) };
for (const v of VARIANTS) {
  const x = all.map((a) => a[v.name]);
  summary[v.name] = { found: x.filter((k) => k.found).length, of: x.length, otherMarksMedian: median(x.map((k) => k.otherMarks)), otherMarksMax: Math.max(...x.map((k) => k.otherMarks)),
    other6to10Median: median(x.map((k) => k.other6to10)), other10to20Median: median(x.map((k) => k.other10to20)), other20plusMedian: median(x.map((k) => k.other20plus)),
    missed: all.filter((a) => !a[v.name].found).map((a) => `${a.case} (${a.expertLongMm} mm, covered ${a[v.name].tumourCovered})`) };
}
console.log(JSON.stringify(summary, null, 1));
if (!pending) { mkdirSync(join(root, 'eval', 'results'), { recursive: true }); writeFileSync(join(root, 'eval', 'results', `${split}_detect.json`), JSON.stringify({ summary, scans: all }, null, 1)); }
