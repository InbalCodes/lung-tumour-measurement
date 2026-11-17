/**
 * Score the tool's own outlining code against the expert outlines.
 *
 * Runs in Node with no build step:   node scripts/evaluate.ts [--split dev|test|all]
 *                                        [--stroke 1.0] [--params '{"openMm":3}'] [--out file]
 *
 * For each case it simulates the researcher's stroke as the expert's long axis (scaled by
 * --stroke), runs the same segmentFromStroke the browser uses, and compares the result with
 * the expert mask. It also reports same-day repeat noise for patients with two scans.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measure } from '../src/core/measure.ts';
import { DEFAULT_PARAMS, segmentFromStroke } from '../src/core/segment.ts';
import type { Mask, Volume } from '../src/core/volume.ts';
import { dice } from '../src/core/volume.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const crops = join(root, 'data', 'derived', 'crops');
const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const split = arg('split', 'dev');
const strokeScale = Number(arg('stroke', '1.0'));
const params = { ...DEFAULT_PARAMS, ...JSON.parse(arg('params', '{}')) };
const quiet = args.includes('--quiet');

const splits = JSON.parse(readFileSync(join(root, 'eval', 'reference', 'splits.json'), 'utf8'));
const patients: string[] = split === 'all' ? [...splits.dev, ...splits.test] : splits[split];

function loadCase(name: string) {
  const meta = JSON.parse(readFileSync(join(crops, `${name}.json`), 'utf8'));
  const [nz, ny, nx] = meta.shape as number[];
  const raw = readFileSync(join(crops, `${name}.i16`));
  const hu = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const volume: Volume = {
    hu, nz, ny, nx, dz: meta.spacing[0], dy: meta.spacing[1], dx: meta.spacing[2],
    sliceNumbers: meta.instance_numbers, origin: [0, 0], zPositions: meta.instance_numbers.map((_: number, i: number) => i * meta.spacing[0]),
    meta: { patientId: meta.patient_id, studyDate: '', seriesNumber: 0, sliceThickness: meta.spacing[0], seriesUid: '', seriesDescription: '' },
  };
  const ref: Mask = { data: new Uint8Array(readFileSync(join(crops, `${name}.u8`))), z0: 0, y0: 0, x0: 0, nz, ny, nx };
  return { meta, volume, ref };
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const r = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

const rows: any[] = [];
let parityWorst = 0;
for (const patient of patients) {
  for (const session of ['test', 'retest']) {
    const name = `${patient}_${session}`;
    let c;
    try { c = loadCase(name); } catch { continue; }
    const refM = measure(c.ref, c.volume);
    // The TypeScript measurement must agree with the Python one that built the reference.
    parityWorst = Math.max(parityWorst,
      Math.abs(refM.longAxisMm - c.meta.reference.long_axis_mm),
      Math.abs(refM.shortAxisMm - c.meta.reference.short_axis_mm),
      Math.abs(refM.volumeMm3 - c.meta.reference.volume_mm3) / c.meta.reference.volume_mm3 * 100);
    const a = refM.longAxis!;
    const mx = (a.x0 + a.x1) / 2, my = (a.y0 + a.y1) / 2;
    const stroke = {
      z: refM.sliceIndex,
      x0: mx + (a.x0 - mx) * strokeScale, y0: my + (a.y0 - my) * strokeScale,
      x1: mx + (a.x1 - mx) * strokeScale, y1: my + (a.y1 - my) * strokeScale,
    };
    const t0 = performance.now();
    const res = segmentFromStroke(c.volume, stroke, params);
    const ms = performance.now() - t0;
    if (!res) { rows.push({ name, patient, session, failed: true, refVol: refM.volumeMm3, refLong: refM.longAxisMm }); continue; }
    const m = measure(res.mask, c.volume);
    rows.push({
      name, patient, session, failed: false,
      dice: dice(res.mask, c.ref),
      volPct: 100 * (m.volumeMm3 - refM.volumeMm3) / refM.volumeMm3,
      longMm: m.longAxisMm - refM.longAxisMm,
      shortMm: m.shortAxisMm - refM.shortAxisMm,
      vol: m.volumeMm3, refVol: refM.volumeMm3, refLong: refM.longAxisMm, long: m.longAxisMm,
      threshold: res.thresholdHu, tumourHu: res.tumourHu, backgroundHu: res.backgroundHu, ms,
    });
  }
}

const ok = rows.filter((x) => !x.failed);
if (!quiet) {
  console.log('case                      refLong  dice   vol%    long   short  thr   ms');
  for (const x of rows) {
    if (x.failed) { console.log(`${x.name.padEnd(26)}${String(x.refLong).padStart(6)}  FAILED`); continue; }
    console.log(`${x.name.padEnd(26)}${String(x.refLong).padStart(6)}  ${x.dice.toFixed(2)}  ${r(x.volPct).toString().padStart(6)}  ${r(x.longMm).toString().padStart(5)}  ${r(x.shortMm).toString().padStart(5)}  ${Math.round(x.threshold).toString().padStart(5)}  ${Math.round(x.ms)}`);
  }
}

// Same-day repeat noise of the tool, on patients with both scans.
const byPatient = new Map<string, any>();
for (const x of ok) byPatient.set(x.patient, { ...(byPatient.get(x.patient) ?? {}), [x.session]: x });
const pairs = [...byPatient.values()].filter((p) => p.test && p.retest);
const toolNoise = pairs.map((p) => 100 * (p.retest.vol - p.test.vol) / ((p.retest.vol + p.test.vol) / 2));
const expertNoise = pairs.map((p) => 100 * (p.retest.refVol - p.test.refVol) / ((p.retest.refVol + p.test.refVol) / 2));

const summary = {
  split, strokeScale, params, cases: rows.length, failed: rows.length - ok.length,
  measurementParityWorst: r(parityWorst, 3),
  diceMean: r(mean(ok.map((x) => x.dice)), 3), diceMedian: r(median(ok.map((x) => x.dice)), 3),
  diceMin: r(Math.min(...ok.map((x) => x.dice)), 3),
  volumeAbsPctMedian: r(median(ok.map((x) => Math.abs(x.volPct)))),
  volumePctMean: r(mean(ok.map((x) => x.volPct))),
  longAxisAbsMmMedian: r(median(ok.map((x) => Math.abs(x.longMm)))),
  shortAxisAbsMmMedian: r(median(ok.map((x) => Math.abs(x.shortMm)))),
  msMedian: Math.round(median(ok.map((x) => x.ms))),
  repeatPairs: pairs.length,
  repeatToolAbsPctMedian: r(median(toolNoise.map(Math.abs))),
  repeatToolSd: pairs.length > 1 ? r(sd(toolNoise)) : null,
  repeatExpertAbsPctMedian: r(median(expertNoise.map(Math.abs))),
  repeatExpertSd: pairs.length > 1 ? r(sd(expertNoise)) : null,
};
console.log(JSON.stringify(summary, null, quiet ? 0 : 1));
const out = arg('out', '');
if (out) writeFileSync(out, JSON.stringify({ summary, rows }, null, 1));
