import type { Measurement } from './measure.ts';
import type { Mask, Volume } from './volume.ts';

/** Position in patient space, mm: x (left-right), y (front-back), z (along the body). */
export type PointMm = [number, number, number];

export function voxelToMm(v: Volume, z: number, y: number, x: number): PointMm {
  const k = Math.max(0, Math.min(v.nz - 1, z)), k0 = Math.floor(k), k1 = Math.min(k0 + 1, v.nz - 1);
  const zMm = v.zPositions[k0] + (v.zPositions[k1] - v.zPositions[k0]) * (k - k0);
  return [v.origin[0] + x * v.dx, v.origin[1] + y * v.dy, zMm];
}

/** Voxel coordinates (z, y, x) of a patient-space point; z is the nearest slice. */
export function mmToVoxel(v: Volume, p: PointMm): [number, number, number] {
  let best = 0;
  for (let k = 1; k < v.nz; k++) if (Math.abs(v.zPositions[k] - p[2]) < Math.abs(v.zPositions[best] - p[2])) best = k;
  return [best, (p[1] - v.origin[1]) / v.dy, (p[0] - v.origin[0]) / v.dx];
}

export function maskCentroidMm(m: Mask, v: Volume): PointMm {
  let sz = 0, sy = 0, sx = 0, n = 0;
  for (let z = 0, i = 0; z < m.nz; z++)
    for (let y = 0; y < m.ny; y++)
      for (let x = 0; x < m.nx; x++, i++)
        if (m.data[i]) { sz += z; sy += y; sx += x; n++; }
  return voxelToMm(v, m.z0 + sz / n, m.y0 + sy / n, m.x0 + sx / n);
}

// ------------------------------------------------------- lining up two scans

/** A small, blurred copy of a scan on an even grid, used only to line two scans up. */
export interface Thumb {
  /** Patient-space position (mm) of the centre of the first cell. */
  origin: PointMm;
  spacing: number;
  nz: number; ny: number; nx: number;
  /** Density per cell, 0..255 for -1000..400 HU. */
  data: Uint8Array;
}

const toByte = (hu: number) => Math.max(0, Math.min(255, Math.round((hu + 1000) * (255 / 1400))));

/** Average the scan into cubes of `spacing` mm. */
export function thumbnail(v: Volume, spacing = 8): Thumb {
  const zLo = Math.min(v.zPositions[0], v.zPositions[v.nz - 1]);
  const zSign = v.zPositions[v.nz - 1] >= v.zPositions[0] ? 1 : -1;
  const nx = Math.max(1, Math.floor((v.nx * v.dx) / spacing)), ny = Math.max(1, Math.floor((v.ny * v.dy) / spacing));
  const nz = Math.max(1, Math.floor((v.nz * v.dz) / spacing));
  const sum = new Float64Array(nz * ny * nx), cnt = new Uint32Array(nz * ny * nx);
  const sx = Math.max(1, Math.round(2 / v.dx)), sy = Math.max(1, Math.round(2 / v.dy));
  for (let z = 0; z < v.nz; z++) {
    const cz = Math.floor((zSign > 0 ? z : v.nz - 1 - z) * v.dz / spacing);
    if (cz >= nz) continue;
    for (let y = 0; y < v.ny; y += sy) {
      const cy = Math.floor((y * v.dy) / spacing);
      if (cy >= ny) continue;
      for (let x = 0; x < v.nx; x += sx) {
        const cx = Math.floor((x * v.dx) / spacing);
        if (cx >= nx) continue;
        const i = (cz * ny + cy) * nx + cx;
        sum[i] += Math.max(-1000, Math.min(400, v.hu[(z * v.ny + y) * v.nx + x]));
        cnt[i]++;
      }
    }
  }
  const data = new Uint8Array(sum.length);
  for (let i = 0; i < data.length; i++) data[i] = cnt[i] ? toByte(sum[i] / cnt[i]) : 0;
  return { origin: [v.origin[0] + spacing / 2, v.origin[1] + spacing / 2, zLo + spacing / 2], spacing, nz, ny, nx, data };
}

function halve(t: Thumb): Thumb {
  const nz = Math.floor(t.nz / 2), ny = Math.floor(t.ny / 2), nx = Math.floor(t.nx / 2);
  const data = new Uint8Array(nz * ny * nx);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    let s = 0;
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++)
      s += t.data[((2 * z + a) * t.ny + 2 * y + b) * t.nx + 2 * x + c];
    data[(z * ny + y) * nx + x] = s / 8;
  }
  const h = t.spacing / 2;
  return { origin: [t.origin[0] + h, t.origin[1] + h, t.origin[2] + h], spacing: t.spacing * 2, nz, ny, nx, data };
}

/** Correlation of two grids when `a` is shifted by (dz, dy, dx) cells of `b`; -2 if they barely overlap. */
function correlation(a: Thumb, b: Thumb, oz: number, oy: number, ox: number): number {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let z = 0; z < a.nz; z++) {
    const bz = z + oz;
    if (bz < 0 || bz >= b.nz) continue;
    for (let y = 0; y < a.ny; y++) {
      const by = y + oy;
      if (by < 0 || by >= b.ny) continue;
      for (let x = 0; x < a.nx; x++) {
        const bx = x + ox;
        if (bx < 0 || bx >= b.nx) continue;
        const p = a.data[(z * a.ny + y) * a.nx + x], q = b.data[(bz * b.ny + by) * b.nx + bx];
        n++; sa += p; sb += q; saa += p * p; sbb += q * q; sab += p * q;
      }
    }
  }
  if (n < a.data.length * 0.35) return -2;
  const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
  return va > 0 && vb > 0 ? (sab - (sa * sb) / n) / Math.sqrt(va * vb) : -2;
}

/**
 * Shift (mm) that carries a point of the prior scan onto the same anatomy in the current scan.
 * Whole-scan translation only, found coarse-to-fine by correlating the two thumbnails.
 */
export function alignScans(prior: Thumb, current: Thumb, reachMm = 100): PointMm {
  const search = (a: Thumb, b: Thumb, centre: [number, number, number], radius: number) => {
    // Offset in cells between the grids when the patient-space shift is zero.
    const base = [0, 1, 2].map((k) => Math.round((a.origin[2 - k] - b.origin[2 - k]) / a.spacing));
    let best = -3, at: [number, number, number] = centre;
    for (let dz = centre[0] - radius; dz <= centre[0] + radius; dz++)
      for (let dy = centre[1] - radius; dy <= centre[1] + radius; dy++)
        for (let dx = centre[2] - radius; dx <= centre[2] + radius; dx++) {
          const c = correlation(a, b, base[0] + dz, base[1] + dy, base[2] + dx);
          if (c > best) { best = c; at = [dz, dy, dx]; }
        }
    return at;
  };
  const pa = halve(prior), pb = halve(current);
  const coarse = search(pa, pb, [0, 0, 0], Math.ceil(reachMm / pa.spacing));
  const fine = search(prior, current, [coarse[0] * 2, coarse[1] * 2, coarse[2] * 2], 2);
  return [fine[2] * prior.spacing, fine[1] * prior.spacing, fine[0] * prior.spacing];
}

/** A cube of the scan around a point, resampled to an even grid; used to re-find a nodule. */
export interface Patch { size: number; spacing: number; data: Uint8Array }

export function patchAround(v: Volume, centre: PointMm, halfMm: number, spacing = 2): Patch {
  const half = Math.round(halfMm / spacing), size = 2 * half + 1;
  const data = new Uint8Array(size * size * size);
  const rising = v.zPositions[v.nz - 1] >= v.zPositions[0];
  for (let k = 0, i = 0; k < size; k++) {
    const zMm = centre[2] + (k - half) * spacing;
    const z = Math.round((rising ? zMm - v.zPositions[0] : v.zPositions[0] - zMm) / v.dz);
    for (let j = 0; j < size; j++) {
      const y = Math.round((centre[1] + (j - half) * spacing - v.origin[1]) / v.dy);
      for (let h = 0; h < size; h++, i++) {
        const x = Math.round((centre[0] + (h - half) * spacing - v.origin[0]) / v.dx);
        data[i] = z < 0 || y < 0 || x < 0 || z >= v.nz || y >= v.ny || x >= v.nx
          ? 0 : toByte(Math.max(-1000, Math.min(400, v.hu[(z * v.ny + y) * v.nx + x])));
      }
    }
  }
  return { size, spacing, data };
}

/**
 * Fine-tune an expected nodule position: slide the prior scan's patch over the current scan
 * around `expected` and return the position where the anatomy matches best.
 */
export function refinePosition(v: Volume, prior: Patch, expected: PointMm, reachMm = 16): PointMm {
  const reach = Math.round(reachMm / prior.spacing), half = (prior.size - 1) / 2;
  const block = patchAround(v, expected, (half + reach) * prior.spacing, prior.spacing);
  const S = prior.size, B = block.size;
  let best = -3, at: [number, number, number] = [0, 0, 0];
  for (let dz = 0; dz <= 2 * reach; dz++)
    for (let dy = 0; dy <= 2 * reach; dy++)
      for (let dx = 0; dx <= 2 * reach; dx++) {
        let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
        // Every second cell is enough to score a position and keeps the search fast.
        let n = 0;
        for (let z = 0; z < S; z += 2) for (let y = 0; y < S; y += 2) for (let x = 0; x < S; x += 2) {
          const p = prior.data[(z * S + y) * S + x], q = block.data[((z + dz) * B + y + dy) * B + x + dx];
          n++; sa += p; sb += q; saa += p * p; sbb += q * q; sab += p * q;
        }
        const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
        const c = va > 0 && vb > 0 ? (sab - (sa * sb) / n) / Math.sqrt(va * vb) : -2;
        if (c > best) { best = c; at = [dz - reach, dy - reach, dx - reach]; }
      }
  return [expected[0] + at[2] * prior.spacing, expected[1] + at[1] * prior.spacing, expected[2] + at[0] * prior.spacing];
}

export const distanceMm = (a: PointMm, b: PointMm) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ------------------------------------------------------------------ sessions

/** What is kept from one measured scan so the next scan of the patient can start from it. */
export interface SessionNodule {
  noduleId: string;
  lobe: string;
  type: string;
  centroidMm: PointMm;
  /** 2 mm image patch around the nodule, base64; used to re-find it on the next scan. */
  patch: { size: number; spacing: number; data: string };
  longAxisMm: number;
  shortAxisMm: number;
  volumeMm3: number;
  sliceNumber: number;
}

export interface Session {
  format: 'lung-tumour-measurement/session';
  version: 1;
  savedAt: string;
  patientId: string;
  scanDate: string;
  timepoint: string;
  seriesUid: string;
  /** Blurred 8 mm copy of the scan, base64; lines the next scan up with this one. */
  thumb: Omit<Thumb, 'data'> & { data: string };
  nodules: SessionNodule[];
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function sessionNodule(v: Volume, mask: Mask, m: Measurement, fields: { noduleId: string; lobe: string; type: string }): SessionNodule {
  const centroid = maskCentroidMm(mask, v);
  const patch = patchAround(v, centroid, 20);
  return {
    noduleId: fields.noduleId, lobe: fields.lobe, type: fields.type, centroidMm: centroid,
    patch: { size: patch.size, spacing: patch.spacing, data: toBase64(patch.data) },
    longAxisMm: m.longAxisMm, shortAxisMm: m.shortAxisMm, volumeMm3: Math.round(m.volumeMm3),
    sliceNumber: m.sliceIndex >= 0 ? v.sliceNumbers[m.sliceIndex] : 0,
  };
}

export function parseSession(text: string): Session {
  const s = JSON.parse(text);
  if (s?.format !== 'lung-tumour-measurement/session' || !Array.isArray(s.nodules) || !s.thumb)
    throw new Error('This file is not a saved session from this tool.');
  return s as Session;
}

/** "Baseline" -> "Follow-up 1", "Follow-up 2" -> "Follow-up 3". */
export function nextTimepoint(prior: string): string {
  const n = /follow-?up\s*(\d+)/i.exec(prior);
  return n ? `Follow-up ${Number(n[1]) + 1}` : 'Follow-up 1';
}

export interface PriorMatch { nodule: SessionNodule; distanceMm: number; confidence: 'Confident' | 'Uncertain' }

/**
 * Match a newly outlined tumour to the nearest prior nodule that is not matched yet.
 * Confident: the new centre lies within the prior nodule's own radius (at least 10 mm) of where
 * it was expected. Uncertain: within three times that. Further away: no match.
 */
export function matchPrior(centroid: PointMm, expected: { nodule: SessionNodule; at: PointMm }[], taken: Set<string>): PriorMatch | null {
  let best: PriorMatch | null = null;
  for (const e of expected) {
    if (taken.has(e.nodule.noduleId)) continue;
    const d = distanceMm(centroid, e.at);
    const radius = Math.max(10, e.nodule.longAxisMm / 2);
    if (d > radius * 3) continue;
    if (!best || d < best.distanceMm) best = { nodule: e.nodule, distanceMm: d, confidence: d <= radius ? 'Confident' : 'Uncertain' };
  }
  return best;
}
