import type { Mask, Volume } from './volume.ts';
import { cropMask, emptyMask } from './volume.ts';

/**
 * The researcher drags a line across the tumour on one slice, as they would to measure its
 * diameter. The line gives a centre, a size and a sample of the tumour's density.
 * Coordinates are volume column (x) and row (y), in pixels; z is the slice index.
 */
export interface Stroke { z: number; x0: number; y0: number; x1: number; y1: number }

export interface SegmentParams {
  /** In-plane search radius = boundScale * (stroke length / 2) + padMm. */
  boundScale: number;
  /** Search radius along z, as a multiple of half the stroke length. */
  zScale: number;
  padMm: number;
  /** Radius of the opening that cuts vessels and thin bridges, capped at openFrac * length. */
  openMm: number;
  openFrac: number;
  /** Where the density threshold sits between lung background (0) and tumour (1). */
  thresholdFrac: number;
  minThresholdHu: number;
  maxThresholdHu: number;
  /** Voxels denser than this (bone) are never part of the outline. */
  upperHu: number;
  /** Average each voxel with its in-plane neighbours first; lung reconstructions are noisy. */
  smooth: boolean;
  /**
   * Fit the width of the search region to the tumour instead of assuming it is as wide as it is
   * long. The width is measured from the stroke towards the lung on each side, and the smaller
   * side is used, so a tumour lying against the chest wall does not pull the wall in.
   */
  fitWidth: boolean;
  /**
   * Use this density threshold instead of estimating one. On a follow-up scan the prior scan's
   * threshold is reused, so the same tumour is cut at the same density both times.
   */
  fixedThresholdHu: number | null;
  /** Search depth along z: 0 = as deep as the fitted width, 1 = as deep as the stroke is long. */
  zMix: number;
}

export const DEFAULT_PARAMS: SegmentParams = {
  boundScale: 1.0, zScale: 1.0, padMm: 2, openMm: 1, openFrac: 0.12,
  thresholdFrac: 0.5, minThresholdHu: -750, maxThresholdHu: -200, upperHu: 300, smooth: true, fitWidth: true, zMix: 1, fixedThresholdHu: null,
};

export interface SegmentResult {
  mask: Mask;
  thresholdHu: number;
  tumourHu: number;
  backgroundHu: number;
  strokeMm: number;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/**
 * Outline a tumour in 3D from one stroke.
 *
 * 1. Limit the search to an ellipsoid sized from the stroke.
 * 2. Pick a density threshold halfway between the tumour (sampled along the stroke) and the
 *    surrounding lung.
 * 3. Erode to cut vessels and thin attachments, keep the piece under the stroke, grow it back.
 * 4. Fill holes slice by slice.
 */
export function segmentFromStroke(v: Volume, s: Stroke, p: SegmentParams = DEFAULT_PARAMS): SegmentResult | null {
  const lenMm = Math.hypot((s.x1 - s.x0) * v.dx, (s.y1 - s.y0) * v.dy);
  if (lenMm < 2) return null;
  const cx = (s.x0 + s.x1) / 2, cy = (s.y0 + s.y1) / 2, cz = Math.round(s.z);
  const rXY = p.boundScale * lenMm / 2 + p.padMm;
  const rZ = p.zScale * lenMm / 2 + p.padMm;

  const z0 = Math.max(Math.floor(cz - rZ / v.dz), 0), z1 = Math.min(Math.ceil(cz + rZ / v.dz), v.nz - 1);
  const y0 = Math.max(Math.floor(cy - rXY / v.dy), 0), y1 = Math.min(Math.ceil(cy + rXY / v.dy), v.ny - 1);
  const x0 = Math.max(Math.floor(cx - rXY / v.dx), 0), x1 = Math.min(Math.ceil(cx + rXY / v.dx), v.nx - 1);
  const nz = z1 - z0 + 1, ny = y1 - y0 + 1, nx = x1 - x0 + 1;
  if (nz < 1 || ny < 1 || nx < 1) return null;
  const n = nz * ny * nx, slice = ny * nx;
  // Local copy of the search box, optionally smoothed with a 3x3 in-plane mean.
  const box = new Int16Array(n);
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++) {
      const src = ((z + z0) * v.ny + (y + y0)) * v.nx + x0;
      box.set(v.hu.subarray(src, src + nx), z * slice + y * nx);
    }
  let dens = box;
  if (p.smooth) {
    dens = new Int16Array(n);
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          let sum = 0, count = 0;
          for (let yy = Math.max(y - 1, 0); yy <= Math.min(y + 1, ny - 1); yy++)
            for (let xx = Math.max(x - 1, 0); xx <= Math.min(x + 1, nx - 1); xx++) { sum += box[z * slice + yy * nx + xx]; count++; }
          dens[z * slice + y * nx + x] = Math.round(sum / count);
        }
  }
  const huAt = (z: number, y: number, x: number) => dens[(z - z0) * slice + (y - y0) * nx + (x - x0)];

  // Tumour density: median along the middle 80% of the stroke.
  const strokeVox: number[] = [];
  const samples: number[] = [];
  const steps = Math.max(8, Math.ceil(lenMm / Math.min(v.dx, v.dy)));
  for (let i = 0; i <= steps; i++) {
    const t = 0.1 + 0.8 * (i / steps);
    const x = Math.round(s.x0 + (s.x1 - s.x0) * t), y = Math.round(s.y0 + (s.y1 - s.y0) * t);
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    samples.push(huAt(cz, y, x));
    strokeVox.push(((cz - z0) * ny + (y - y0)) * nx + (x - x0));
  }
  if (!samples.length) return null;
  const tumourHu = median(samples);

  // Lung background: 10th percentile inside the search ellipse on the stroke's slice.
  const around: number[] = [];
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const ex = (x - cx) * v.dx / rXY, ey = (y - cy) * v.dy / rXY;
      if (ex * ex + ey * ey <= 1) around.push(huAt(cz, y, x));
    }
  around.sort((a, b) => a - b);
  const backgroundHu = around[Math.floor(around.length * 0.1)] ?? -850;
  let thresholdHu = backgroundHu + p.thresholdFrac * (tumourHu - backgroundHu);
  thresholdHu = Math.min(Math.max(thresholdHu, p.minThresholdHu), p.maxThresholdHu);
  if (p.fixedThresholdHu !== null) thresholdHu = p.fixedThresholdHu;

  // Shape of the search region: an ellipsoid whose long axis is the stroke.
  const ux = (s.x1 - s.x0) * v.dx / lenMm, uy = (s.y1 - s.y0) * v.dy / lenMm;
  let rShort = rXY, rDepth = rZ;
  if (p.fitWidth) {
    // Walk out from the stroke on both sides until the tissue ends; keep the smaller side.
    const reach = (px: number, py: number, sign: number) => {
      const limit = lenMm * 0.6, step = Math.min(v.dx, v.dy) / 2;
      for (let d = 0; d <= limit; d += step) {
        const x = Math.round(px + sign * -uy * d / v.dx), y = Math.round(py + sign * ux * d / v.dy);
        if (x < x0 || x > x1 || y < y0 || y > y1 || huAt(cz, y, x) < thresholdHu) return d;
      }
      return limit;
    };
    let half = 0;
    for (let i = 0; i <= steps; i++) {
      const t = 0.15 + 0.7 * (i / steps);
      const px = s.x0 + (s.x1 - s.x0) * t, py = s.y0 + (s.y1 - s.y0) * t;
      half = Math.max(half, Math.min(reach(px, py, 1), reach(px, py, -1)));
    }
    rShort = Math.min(rXY, Math.max(half, 1.5) * p.boundScale + p.padMm);
    rDepth = p.zScale * (p.zMix * (lenMm / 2) + (1 - p.zMix) * half) + p.padMm;
  }

  // Candidate voxels: dense enough, not bone, inside the ellipsoid.
  const cand = new Uint8Array(n);
  for (let z = 0, i = 0; z < nz; z++) {
    const ez = (z + z0 - cz) * v.dz / rDepth;
    for (let y = 0; y < ny; y++) {
      const my = (y + y0 - cy) * v.dy;
      for (let x = 0; x < nx; x++, i++) {
        const mx = (x + x0 - cx) * v.dx;
        const ex = (mx * ux + my * uy) / rXY, ey = (-mx * uy + my * ux) / rShort;
        if (ex * ex + ey * ey + ez * ez > 1) continue;
        const h = huAt(z + z0, y + y0, x + x0);
        if (h >= thresholdHu && h <= p.upperHu) cand[i] = 1;
      }
    }
  }

  const openMm = Math.min(p.openMm, p.openFrac * lenMm);
  const itXY = Math.round(openMm / ((v.dx + v.dy) / 2));
  const itZ = Math.round(openMm / v.dz);

  const erodeXY = (src: Uint8Array) => {
    const dst = new Uint8Array(n);
    for (let z = 0; z < nz; z++)
      for (let y = 1; y < ny - 1; y++)
        for (let x = 1, i = z * slice + y * nx + 1; x < nx - 1; x++, i++)
          if (src[i] && src[i - 1] && src[i + 1] && src[i - nx] && src[i + nx]) dst[i] = 1;
    return dst;
  };
  const erodeZ = (src: Uint8Array) => {
    const dst = new Uint8Array(n);
    for (let i = slice; i < n - slice; i++) if (src[i] && src[i - slice] && src[i + slice]) dst[i] = 1;
    return dst;
  };
  let core = cand;
  for (let k = 0; k < itXY; k++) core = erodeXY(core);
  for (let k = 0; k < itZ; k++) core = erodeZ(core);

  // Keep the piece of the core that lies under the stroke. If erosion removed everything under
  // the stroke (a small or thin nodule), fall back to the un-eroded candidates.
  let seeds = strokeVox.filter((i) => core[i]);
  let grow = itXY + 1, growZ = itZ + 1;
  if (!seeds.length) {
    core = cand; seeds = strokeVox.filter((i) => cand[i]); grow = 0; growZ = 0;
    if (!seeds.length) return null;
  }
  const kept = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  for (const i of seeds) if (!kept[i]) { kept[i] = 1; stack[top++] = i; }
  while (top) {
    const i = stack[--top];
    const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / slice);
    if (x > 0 && core[i - 1] && !kept[i - 1]) { kept[i - 1] = 1; stack[top++] = i - 1; }
    if (x < nx - 1 && core[i + 1] && !kept[i + 1]) { kept[i + 1] = 1; stack[top++] = i + 1; }
    if (y > 0 && core[i - nx] && !kept[i - nx]) { kept[i - nx] = 1; stack[top++] = i - nx; }
    if (y < ny - 1 && core[i + nx] && !kept[i + nx]) { kept[i + nx] = 1; stack[top++] = i + nx; }
    if (z > 0 && core[i - slice] && !kept[i - slice]) { kept[i - slice] = 1; stack[top++] = i - slice; }
    if (z < nz - 1 && core[i + slice] && !kept[i + slice]) { kept[i + slice] = 1; stack[top++] = i + slice; }
  }

  // Grow back to the original surface, never leaving the candidate voxels.
  let out = kept;
  const dilateXY = (src: Uint8Array) => {
    const dst = src.slice();
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0, i = z * slice + y * nx; x < nx; x++, i++) {
          if (src[i] || !cand[i]) continue;
          if ((x > 0 && src[i - 1]) || (x < nx - 1 && src[i + 1]) || (y > 0 && src[i - nx]) || (y < ny - 1 && src[i + nx])) dst[i] = 1;
        }
    return dst;
  };
  const dilateZ = (src: Uint8Array) => {
    const dst = src.slice();
    for (let i = 0; i < n; i++) {
      if (src[i] || !cand[i]) continue;
      if ((i >= slice && src[i - slice]) || (i < n - slice && src[i + slice])) dst[i] = 1;
    }
    return dst;
  };
  for (let k = 0; k < grow; k++) out = dilateXY(out);
  for (let k = 0; k < growZ; k++) out = dilateZ(out);

  fillHoles2D(out, nz, ny, nx);
  const full = emptyMask(z0, y0, x0, nz, ny, nx);
  full.data.set(out);
  const mask = cropMask(full);
  return mask ? { mask, thresholdHu, tumourHu, backgroundHu, strokeMm: lenMm } : null;
}

/** Fill enclosed holes on every slice (air pockets, low-density centres). */
export function fillHoles2D(data: Uint8Array, nz: number, ny: number, nx: number): void {
  const slice = ny * nx;
  const outside = new Uint8Array(slice);
  const stack = new Int32Array(slice);
  for (let z = 0; z < nz; z++) {
    const base = z * slice;
    outside.fill(0);
    let top = 0;
    const push = (i: number) => { if (!outside[i] && !data[base + i]) { outside[i] = 1; stack[top++] = i; } };
    for (let x = 0; x < nx; x++) { push(x); push((ny - 1) * nx + x); }
    for (let y = 0; y < ny; y++) { push(y * nx); push(y * nx + nx - 1); }
    while (top) {
      const i = stack[--top];
      const x = i % nx, y = (i - x) / nx;
      if (x > 0) push(i - 1);
      if (x < nx - 1) push(i + 1);
      if (y > 0) push(i - nx);
      if (y < ny - 1) push(i + nx);
    }
    for (let i = 0; i < slice; i++) if (!outside[i]) data[base + i] = 1;
  }
}
