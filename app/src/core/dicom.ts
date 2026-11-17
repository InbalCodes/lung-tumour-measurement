import dicomParser from 'dicom-parser';
import type { ScanMeta, Volume } from './volume.ts';

/** One CT slice read from a DICOM file, with pixels already in Hounsfield units. */
export interface ParsedSlice {
  seriesUid: string;
  rows: number;
  cols: number;
  x: number;
  y: number;
  z: number;
  dy: number;
  dx: number;
  instanceNumber: number;
  hu: Int16Array;
  meta: ScanMeta;
}

const UNCOMPRESSED = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1']);

/**
 * Parse one DICOM file. Returns null for files that are not CT image slices.
 * Throws for CT slices stored in a compressed transfer syntax, which this version cannot read.
 */
export function parseSlice(buffer: ArrayBuffer): ParsedSlice | null {
  let ds;
  try {
    ds = dicomParser.parseDicom(new Uint8Array(buffer));
  } catch {
    return null;
  }
  const pixels = ds.elements.x7fe00010;
  if (!pixels || ds.string('x00080060') !== 'CT') return null;
  const syntax = ds.string('x00020010') ?? '1.2.840.10008.1.2';
  if (!UNCOMPRESSED.has(syntax)) throw new Error(`Compressed DICOM is not supported yet (transfer syntax ${syntax}).`);

  const rows = ds.uint16('x00280010') ?? 0, cols = ds.uint16('x00280011') ?? 0;
  if (!rows || !cols || (ds.uint16('x00280100') ?? 16) !== 16) return null;
  const signed = ds.uint16('x00280103') === 1;
  const slope = ds.floatString('x00281053') ?? 1, intercept = ds.floatString('x00281052') ?? 0;

  const count = rows * cols;
  const raw = buffer.slice(pixels.dataOffset, pixels.dataOffset + count * 2);
  const stored = signed ? new Int16Array(raw) : new Uint16Array(raw);
  const hu = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    const value = stored[i] * slope + intercept;
    hu[i] = value < -32768 ? -32768 : value > 32767 ? 32767 : value;
  }
  return {
    seriesUid: ds.string('x0020000e') ?? '',
    rows, cols,
    x: ds.floatString('x00200032', 0) ?? 0,
    y: ds.floatString('x00200032', 1) ?? 0,
    z: ds.floatString('x00200032', 2) ?? 0,
    dy: ds.floatString('x00280030', 0) ?? 1,
    dx: ds.floatString('x00280030', 1) ?? 1,
    instanceNumber: ds.intString('x00200013') ?? 0,
    hu,
    meta: {
      patientId: ds.string('x00100020') ?? '',
      studyDate: ds.string('x00080020') ?? '',
      seriesNumber: ds.intString('x00200011') ?? 0,
      sliceThickness: ds.floatString('x00180050') ?? 0,
      seriesUid: ds.string('x0020000e') ?? '',
      seriesDescription: ds.string('x0008103e') ?? '',
    },
  };
}

/** Assemble slices into a volume. If several series are present, the largest one is used. */
export function buildVolume(slices: ParsedSlice[]): Volume {
  const bySeries = new Map<string, ParsedSlice[]>();
  for (const s of slices) bySeries.set(s.seriesUid, [...(bySeries.get(s.seriesUid) ?? []), s]);
  const series = [...bySeries.values()].sort((a, b) => b.length - a.length)[0];
  if (!series || series.length < 2) throw new Error('No CT series with at least two slices was found.');
  series.sort((a, b) => a.z - b.z);
  const { rows, cols, dy, dx, meta } = series[0];
  const usable = series.filter((s) => s.rows === rows && s.cols === cols);
  const gaps = usable.slice(1).map((s, i) => s.z - usable[i].z).sort((a, b) => a - b);
  const dz = gaps[Math.floor(gaps.length / 2)] || meta.sliceThickness || 1;
  const hu = new Int16Array(usable.length * rows * cols);
  usable.forEach((s, i) => hu.set(s.hu, i * rows * cols));
  return { hu, nz: usable.length, ny: rows, nx: cols, dz, dy, dx, sliceNumbers: usable.map((s) => s.instanceNumber),
    origin: [usable[0].x, usable[0].y], zPositions: usable.map((s) => s.z), meta,
  };
}
