import type { Mask, Volume } from './volume.ts';
import { maskVoxelCount, voxelVolumeMm3 } from './volume.ts';

export interface AxisLine {
  /** Endpoints in volume column/row coordinates (pixel centres). */
  x0: number; y0: number; x1: number; y1: number;
}

export interface Measurement {
  volumeMm3: number;
  longAxisMm: number;
  shortAxisMm: number;
  meanDiameterMm: number;
  /** Volume slice index (z) where the long axis is largest; -1 for an empty mask. */
  sliceIndex: number;
  nSlices: number;
  nVoxels: number;
  longAxis: AxisLine | null;
  shortAxis: AxisLine | null;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Pixels of one mask slice that touch the background (4-neighbourhood). */
function boundary(m: Mask, z: number): number[] {
  const pts: number[] = [];
  const base = z * m.ny * m.nx;
  for (let y = 0; y < m.ny; y++)
    for (let x = 0; x < m.nx; x++) {
      const i = base + y * m.nx + x;
      if (!m.data[i]) continue;
      const inner = y > 0 && y < m.ny - 1 && x > 0 && x < m.nx - 1 &&
        m.data[i - 1] && m.data[i + 1] && m.data[i - m.nx] && m.data[i + m.nx];
      if (!inner) pts.push(x, y);
    }
  return pts;
}

/**
 * Long and short axis of one slice, in mm.
 * Long axis: largest distance between two boundary pixel centres, plus one pixel so the length
 * runs edge to edge. Short axis: largest extent perpendicular to it, measured the same way.
 * This mirrors eval/lib.py so expert and tool outlines are measured identically.
 */
function sliceAxes(m: Mask, z: number, v: Volume) {
  const pts = boundary(m, z);
  const n = pts.length / 2;
  if (n === 0) return null;
  const pixel = (v.dy + v.dx) / 2;
  let best = -1, bi = 0, bj = 0;
  for (let i = 0; i < n; i++) {
    const xi = pts[2 * i] * v.dx, yi = pts[2 * i + 1] * v.dy;
    for (let j = i + 1; j < n; j++) {
      const ddx = pts[2 * j] * v.dx - xi, ddy = pts[2 * j + 1] * v.dy - yi;
      const d = ddx * ddx + ddy * ddy;
      if (d > best) { best = d; bi = i; bj = j; }
    }
  }
  if (best <= 0) {
    const x = pts[0] + m.x0, y = pts[1] + m.y0;
    return { long: pixel, short: pixel, longAxis: { x0: x, y0: y, x1: x, y1: y }, shortAxis: { x0: x, y0: y, x1: x, y1: y } };
  }
  const len = Math.sqrt(best);
  const ax = pts[2 * bi] * v.dx, ay = pts[2 * bi + 1] * v.dy;
  const ux = (pts[2 * bj] * v.dx - ax) / len, uy = (pts[2 * bj + 1] * v.dy - ay) / len;
  // Project every boundary point on the normal to find the perpendicular extent.
  let lo = Infinity, hi = -Infinity, li = 0, hiI = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[2 * i] * v.dx * -uy + pts[2 * i + 1] * v.dy * ux;
    if (p < lo) { lo = p; li = i; }
    if (p > hi) { hi = p; hiI = i; }
  }
  // Draw the short axis through the midpoint of the long axis, perpendicular to it.
  const mx = (ax + pts[2 * bj] * v.dx) / 2, my = (ay + pts[2 * bj + 1] * v.dy) / 2;
  const mid = mx * -uy + my * ux;
  const toVox = (px: number, py: number) => ({ x: px / v.dx + m.x0, y: py / v.dy + m.y0 });
  const s0 = toVox(mx + (lo - mid) * -uy, my + (lo - mid) * ux);
  const s1 = toVox(mx + (hi - mid) * -uy, my + (hi - mid) * ux);
  void li; void hiI;
  return {
    long: len + pixel,
    short: hi - lo + pixel,
    longAxis: { x0: pts[2 * bi] + m.x0, y0: pts[2 * bi + 1] + m.y0, x1: pts[2 * bj] + m.x0, y1: pts[2 * bj + 1] + m.y0 },
    shortAxis: { x0: s0.x, y0: s0.y, x1: s1.x, y1: s1.y },
  };
}

/** Measurements in the units of the lab's sheet (mm and mm3). */
export function measure(m: Mask, v: Volume): Measurement {
  const nVoxels = maskVoxelCount(m);
  const out: Measurement = {
    volumeMm3: nVoxels * voxelVolumeMm3(v), longAxisMm: 0, shortAxisMm: 0, meanDiameterMm: 0,
    sliceIndex: -1, nSlices: 0, nVoxels, longAxis: null, shortAxis: null,
  };
  let bestLong = 0, bestShort = 0;
  for (let z = 0; z < m.nz; z++) {
    const a = sliceAxes(m, z, v);
    if (!a) continue;
    out.nSlices++;
    if (a.long > bestLong) {
      bestLong = a.long; bestShort = a.short;
      out.sliceIndex = z + m.z0; out.longAxis = a.longAxis; out.shortAxis = a.shortAxis;
    }
  }
  out.longAxisMm = round1(bestLong);
  out.shortAxisMm = round1(bestShort);
  out.meanDiameterMm = round1((bestLong + bestShort) / 2);
  return out;
}
