/**
 * Measure how close the "jump to prior location" lands.
 *
 * For each patient with a same-day pair, the expert's tumour centre in the first scan is carried
 * to the second scan with the same code the browser uses (whole-scan alignment, then a local
 * search with the image patch around the tumour), and compared with the expert's tumour centre
 * in the second scan.
 *
 *   node scripts/evaluate_followup.ts [--split dev|test|all] [--budget seconds]
 * Results are cached per patient under data/derived/followup, so the run can be resumed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVolume, parseSlice } from '../src/core/dicom.ts';
import type { ParsedSlice } from '../src/core/dicom.ts';
import { alignScans, distanceMm, patchAround, refinePosition, thumbnail, voxelToMm } from '../src/core/followup.ts';
import type { PointMm } from '../src/core/followup.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const arg = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const split = arg('split', 'dev');
const budget = Number(arg('budget', '1e9'));
const started = Date.now();
const cache = join(root, 'data', 'derived', 'followup');
mkdirSync(cache, { recursive: true });

const splits = JSON.parse(readFileSync(join(root, 'eval', 'reference', 'splits.json'), 'utf8'));
const patients: string[] = split === 'all' ? [...splits.dev, ...splits.test] : splits[split];
const lines = readFileSync(join(root, 'eval', 'reference', 'reference_measurements.csv'), 'utf8').trim().split('\n');
const head = lines[0].split(',');
const rows = lines.slice(1).map((l) => Object.fromEntries(l.split(',').map((c, i) => [head[i], c]))).filter((r) => r.outline === 'man');

function loadScan(r: Record<string, string>) {
  const dir = join(root, 'data', 'dicom', 'ct', r.series_uid);
  const slices: ParsedSlice[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.dcm'))) {
    const b = readFileSync(join(dir, f));
    const s = parseSlice(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    if (s) slices.push(s);
  }
  const v = buildVolume(slices);
  return { v, centre: voxelToMm(v, Number(r.centroid_z), Number(r.centroid_row), Number(r.centroid_col)) };
}

const out: any[] = [];
let pending = 0;
for (const p of patients) {
  const a = rows.find((r) => r.patient_id === p && r.session === 'test');
  const b = rows.find((r) => r.patient_id === p && r.session === 'retest');
  if (!a || !b) continue;
  const file = join(cache, `${p}.json`);
  if (existsSync(file)) { out.push(JSON.parse(readFileSync(file, 'utf8'))); continue; }
  if ((Date.now() - started) / 1000 > budget) { pending++; continue; }
  const A = loadScan(a), B = loadScan(b);
  const t0 = performance.now();
  const shift = alignScans(thumbnail(A.v), thumbnail(B.v));
  const t1 = performance.now();
  const expected: PointMm = [A.centre[0] + shift[0], A.centre[1] + shift[1], A.centre[2] + shift[2]];
  const refined = refinePosition(B.v, patchAround(A.v, A.centre, 20), expected);
  const t2 = performance.now();
  const res = {
    patient: p, longAxis: Number(a.long_axis_mm),
    unaligned: distanceMm(A.centre, B.centre), aligned: distanceMm(expected, B.centre),
    refined: distanceMm(refined, B.centre), dz: Math.abs(refined[2] - B.centre[2]),
    shift: shift.map(Math.round), alignMs: Math.round(t1 - t0), refineMs: Math.round(t2 - t1),
  };
  writeFileSync(file, JSON.stringify(res));
  out.push(res);
}
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
for (const o of out) console.log(`${o.patient}  tumour ${String(o.longAxis).padStart(5)} mm | same coordinates ${o.unaligned.toFixed(1).padStart(5)} | scans aligned ${o.aligned.toFixed(1).padStart(5)} | refined ${o.refined.toFixed(1).padStart(5)} (z ${o.dz.toFixed(1)}) | shift ${o.shift.join(',')} | ${o.alignMs}+${o.refineMs} ms`);
if (out.length) console.log(JSON.stringify({
  split, pairs: out.length, pending,
  unalignedMedianMm: +med(out.map((o) => o.unaligned)).toFixed(1),
  alignedMedianMm: +med(out.map((o) => o.aligned)).toFixed(1), alignedMaxMm: +Math.max(...out.map((o) => o.aligned)).toFixed(1),
  refinedMedianMm: +med(out.map((o) => o.refined)).toFixed(1), refinedMaxMm: +Math.max(...out.map((o) => o.refined)).toFixed(1),
  refinedWithin10mm: out.filter((o) => o.refined <= 10).length,
  refinedWithinTumourRadius: out.filter((o) => o.refined <= Math.max(10, o.longAxis / 2)).length,
}));
else console.log(`nothing finished yet, ${pending} pairs pending`);
