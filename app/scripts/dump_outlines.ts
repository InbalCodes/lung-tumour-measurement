/**
 * Write the tool's outline for chosen cases next to the expert's, for the failure gallery.
 *
 *   node scripts/dump_outlines.ts <case> [<case> ...]
 * Each outline is produced exactly as in scripts/evaluate.ts (stroke = the expert's long axis)
 * and saved as data/derived/tool/<case>.u8 on the same grid as the case's crop.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measure } from '../src/core/measure.ts';
import { segmentFromStroke } from '../src/core/segment.ts';
import type { Mask, Volume } from '../src/core/volume.ts';
import { dice } from '../src/core/volume.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const crops = join(root, 'data', 'derived', 'crops'), out = join(root, 'data', 'derived', 'tool');
mkdirSync(out, { recursive: true });
const summary = [];
for (const name of process.argv.slice(2)) {
  const meta = JSON.parse(readFileSync(join(crops, `${name}.json`), 'utf8'));
  const [nz, ny, nx] = meta.shape as number[];
  const raw = readFileSync(join(crops, `${name}.i16`));
  const volume: Volume = {
    hu: new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)), nz, ny, nx,
    dz: meta.spacing[0], dy: meta.spacing[1], dx: meta.spacing[2], sliceNumbers: meta.instance_numbers,
    origin: [0, 0], zPositions: meta.instance_numbers.map((_: number, i: number) => i * meta.spacing[0]),
    meta: { patientId: meta.patient_id, studyDate: '', seriesNumber: 0, sliceThickness: meta.spacing[0], seriesUid: '', seriesDescription: '' },
  };
  const ref: Mask = { data: new Uint8Array(readFileSync(join(crops, `${name}.u8`))), z0: 0, y0: 0, x0: 0, nz, ny, nx };
  const refM = measure(ref, volume), a = refM.longAxis!;
  const res = segmentFromStroke(volume, { z: refM.sliceIndex, x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1 });
  const full = new Uint8Array(nz * ny * nx);
  if (res) {
    const m = res.mask;
    for (let z = 0; z < m.nz; z++) for (let y = 0; y < m.ny; y++)
      full.set(m.data.subarray((z * m.ny + y) * m.nx, (z * m.ny + y + 1) * m.nx), ((z + m.z0) * ny + y + m.y0) * nx + m.x0);
  }
  writeFileSync(join(out, `${name}.u8`), full);
  const tm = res ? measure(res.mask, volume) : null;
  summary.push({
    case: name, slice: refM.sliceIndex, stroke: [a.x0, a.y0, a.x1, a.y1],
    dice: res ? +dice(res.mask, ref).toFixed(2) : 0,
    expert: { volume: Math.round(refM.volumeMm3), long: refM.longAxisMm, short: refM.shortAxisMm },
    tool: tm ? { volume: Math.round(tm.volumeMm3), long: tm.longAxisMm, short: tm.shortAxisMm } : null,
    volumePct: tm ? Math.round(100 * (tm.volumeMm3 - refM.volumeMm3) / refM.volumeMm3) : null,
    thresholdHu: res ? Math.round(res.thresholdHu) : null,
  });
}
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
