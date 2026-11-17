/**
 * Check that the browser's DICOM reader gives the same Hounsfield values as the Python
 * pipeline that built the reference.   node scripts/check_loader.ts <case> <series folder>
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVolume, parseSlice } from '../src/core/dicom.ts';
import type { ParsedSlice } from '../src/core/dicom.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [name, seriesDir] = process.argv.slice(2);
const slices: ParsedSlice[] = [];
for (const f of readdirSync(seriesDir).filter((x) => x.endsWith('.dcm'))) {
  const b = readFileSync(join(seriesDir, f));
  const s = parseSlice(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  if (s) slices.push(s);
}
const v = buildVolume(slices);
const meta = JSON.parse(readFileSync(join(root, 'data', 'derived', 'crops', `${name}.json`), 'utf8'));
const raw = readFileSync(join(root, 'data', 'derived', 'crops', `${name}.i16`));
const crop = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const [nz, ny, nx] = meta.shape, [oz, oy, ox] = meta.offset;
let diff = 0;
for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++)
  if (crop[i] !== v.hu[((z + oz) * v.ny + (y + oy)) * v.nx + (x + ox)]) diff++;
console.log(`volume ${v.nz}x${v.ny}x${v.nx}, spacing ${v.dz} ${v.dy} ${v.dx}, patient ${v.meta.patientId}`);
console.log(`voxels compared ${crop.length}, different ${diff}`);
console.log(`spacing matches: ${Math.abs(v.dz - meta.spacing[0]) < 1e-6 && Math.abs(v.dy - meta.spacing[1]) < 1e-6}`);
process.exit(diff === 0 ? 0 : 1);
