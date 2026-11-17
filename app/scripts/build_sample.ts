/**
 * Pack downloaded CT series into single files the site can offer as sample scans.
 *
 *   node scripts/build_sample.ts <id>[@<slice>] "<label>" <series folder> [<id> "<label>" <folder> ...]
 *
 * Writes public/samples/<id>.bin.gz (the scan in Hounsfield units, int16 little endian, gzip)
 * and public/samples/index.json. The site shows sample buttons only when index.json exists.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { buildVolume, parseSlice } from '../src/core/dicom.ts';
import type { ParsedSlice } from '../src/core/dicom.ts';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples');
mkdirSync(out, { recursive: true });
const args = process.argv.slice(2);
const index = [];
for (let i = 0; i + 2 < args.length; i += 3) {
  // "<id>@<slice number>" also tells the site which slice to open on (where the tumour is).
  const [idArg, label, dir] = args.slice(i, i + 3);
  const [id, startSlice] = idArg.split('@');
  const slices: ParsedSlice[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.dcm'))) {
    const b = readFileSync(join(dir, f));
    const s = parseSlice(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    if (s) slices.push(s);
  }
  const { hu, ...rest } = buildVolume(slices);
  const packed = gzipSync(Buffer.from(hu.buffer, hu.byteOffset, hu.byteLength), { level: 6 });
  writeFileSync(join(out, `${id}.bin.gz`), packed);
  index.push({ id, label, startSlice: startSlice ? Number(startSlice) : null, file: `${id}.bin.gz`, megabytes: Math.round(packed.length / 1e6), volume: rest });
  console.log(`${id}: ${rest.nz} slices, ${Math.round(packed.length / 1e6)} MB`);
}
writeFileSync(join(out, 'index.json'), JSON.stringify(index));
