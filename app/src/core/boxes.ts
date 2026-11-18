/**
 * Outline from boxes: the researcher drags a box around the tumour on a few slices, and an image
 * model (MedSAM) outlines the tumour inside the box on every slice in between.
 *
 * This file holds everything except running the model itself, so the same steps are used by the
 * browser tool and by the offline experiment (eval/model, docs/model-experiment.md).
 */
import type { Mask, Volume } from './volume.ts';

/** A box on one slice, in voxel coordinates. */
export interface KeyBox { z: number; x0: number; y0: number; x1: number; y1: number }

/** The square part of each slice that is shown to the model, in voxels. */
export interface Roi { x0: number; y0: number; size: number }

export const MODEL_SIZE = 1024;
export const LOW_SIZE = 256;
/** The model sees the lung window, which separated tumour from chest wall best in the experiment. */
const WINDOW_LO = -1350, WINDOW_HI = 150;

export const sortBoxes = (boxes: KeyBox[]) => [...boxes].sort((a, b) => a.z - b.z);

/** A square around all the boxes with a margin of surrounding tissue, so the tumour fills the model's view. */
export function roiFor(v: Volume, boxes: KeyBox[], marginMm = 35): Roi {
  const x0 = Math.min(...boxes.map((b) => b.x0)), x1 = Math.max(...boxes.map((b) => b.x1));
  const y0 = Math.min(...boxes.map((b) => b.y0)), y1 = Math.max(...boxes.map((b) => b.y1));
  const size = Math.ceil(Math.max(x1 - x0 + (2 * marginMm) / v.dx, y1 - y0 + (2 * marginMm) / v.dy));
  return { x0: Math.round((x0 + x1) / 2 - size / 2), y0: Math.round((y0 + y1) / 2 - size / 2), size };
}

/** The box on slice z: the drawn one, or a straight-line blend of the drawn boxes above and below. */
export function boxAt(sorted: KeyBox[], z: number): [number, number, number, number] | null {
  if (!sorted.length || z < sorted[0].z || z > sorted[sorted.length - 1].z) return null;
  let i = 0;
  while (i < sorted.length - 2 && z > sorted[i + 1].z) i++;
  const a = sorted[i], b = sorted[Math.min(i + 1, sorted.length - 1)];
  const t = b.z === a.z ? 0 : (z - a.z) / (b.z - a.z);
  return [a.x0 + t * (b.x0 - a.x0), a.y0 + t * (b.y0 - a.y0), a.x1 + t * (b.x1 - a.x1), a.y1 + t * (b.y1 - a.y1)];
}

/**
 * Which slices go through the model. Each one takes seconds, and the experiment showed that using
 * every second or third slice changes the result very little, so long tumours are thinned out.
 * The drawn slices and both ends are always included.
 */
export function modelSlices(sorted: KeyBox[], maxSlices = 16): number[] {
  const first = sorted[0].z, last = sorted[sorted.length - 1].z;
  const step = Math.min(3, Math.max(1, Math.ceil((last - first + 1) / maxSlices)));
  const zs = new Set<number>(sorted.map((b) => b.z));
  for (let z = first; z <= last; z += step) zs.add(z);
  zs.add(last);
  return [...zs].sort((a, b) => a - b);
}

/** One slice of the region, in the lung window (0..255), resized to the model's 1024 x 1024 input. */
export function sliceInput(v: Volume, z: number, roi: Roi): Float32Array {
  const img = new Float32Array(MODEL_SIZE * MODEL_SIZE * 3), scale = MODEL_SIZE / roi.size, base = z * v.ny * v.nx;
  const at = (y: number, x: number) => (y < 0 || x < 0 || y >= v.ny || x >= v.nx ? -1024 : v.hu[base + y * v.nx + x]);
  for (let y = 0; y < MODEL_SIZE; y++) {
    const sy = (y + 0.5) / scale - 0.5 + roi.y0, ya = Math.floor(sy), fy = sy - ya;
    for (let x = 0; x < MODEL_SIZE; x++) {
      const sx = (x + 0.5) / scale - 0.5 + roi.x0, xa = Math.floor(sx), fx = sx - xa;
      const hu = (at(ya, xa) * (1 - fx) + at(ya, xa + 1) * fx) * (1 - fy) + (at(ya + 1, xa) * (1 - fx) + at(ya + 1, xa + 1) * fx) * fy;
      const g = Math.min(1, Math.max(0, (hu - WINDOW_LO) / (WINDOW_HI - WINDOW_LO))) * 255, i = (y * MODEL_SIZE + x) * 3;
      img[i] = g; img[i + 1] = g; img[i + 2] = g;
    }
  }
  return img;
}

/** A box in voxels, as the two corner points the model expects (in its 1024 frame). */
export function modelBox(box: readonly number[], roi: Roi): Float32Array {
  const scale = MODEL_SIZE / roi.size;
  const p = (value: number, origin: number) => (value - origin + 0.5) * scale - 0.5;
  return Float32Array.from([p(box[0], roi.x0), p(box[1], roi.y0), p(box[2], roi.x0), p(box[3], roi.y0)]);
}

/** An empty outline covering the region on the slices from the first box to the last. */
export function regionMask(v: Volume, sorted: KeyBox[], roi: Roi): Mask {
  const x0 = Math.max(0, roi.x0), y0 = Math.max(0, roi.y0);
  const nx = Math.min(v.nx, roi.x0 + roi.size) - x0, ny = Math.min(v.ny, roi.y0 + roi.size) - y0;
  const z0 = sorted[0].z, nz = sorted[sorted.length - 1].z - z0 + 1;
  return { data: new Uint8Array(nz * ny * nx), z0, y0, x0, nz, ny, nx };
}

/**
 * Write the model's answer for slice z into the outline. The model returns a 256 x 256 map of
 * scores for the region; a voxel is inside the outline where the score is above zero.
 * (The model's own full-size output is not used: the published export stretches it.)
 */
export function writeSlice(mask: Mask, z: number, low: Float32Array, roi: Roi): void {
  const scale = MODEL_SIZE / roi.size, L = LOW_SIZE, zz = z - mask.z0;
  const q = (value: number, origin: number) => Math.min(L - 1, Math.max(0, ((value - origin + 0.5) * scale) / 4 - 0.5));
  for (let y = 0; y < mask.ny; y++) {
    const sy = q(y + mask.y0, roi.y0), ya = Math.floor(sy), yb = Math.min(L - 1, ya + 1), fy = sy - ya;
    for (let x = 0; x < mask.nx; x++) {
      const sx = q(x + mask.x0, roi.x0), xa = Math.floor(sx), xb = Math.min(L - 1, xa + 1), fx = sx - xa;
      const score = (low[ya * L + xa] * (1 - fx) + low[ya * L + xb] * fx) * (1 - fy) + (low[yb * L + xa] * (1 - fx) + low[yb * L + xb] * fx) * fy;
      mask.data[(zz * mask.ny + y) * mask.nx + x] = score > 0 ? 1 : 0;
    }
  }
}

/** Slices that did not go through the model take the outline of the nearest slice that did. */
export function fillSkipped(mask: Mask, done: number[]): void {
  const plane = mask.ny * mask.nx;
  for (let zz = 0; zz < mask.nz; zz++) {
    const z = zz + mask.z0;
    if (done.includes(z)) continue;
    const near = done.reduce((best, d) => (Math.abs(d - z) < Math.abs(best - z) ? d : best), done[0]) - mask.z0;
    mask.data.copyWithin(zz * plane, near * plane, (near + 1) * plane);
  }
}
