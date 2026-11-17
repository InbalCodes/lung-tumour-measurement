/**
 * A CT scan held in memory as one block of Hounsfield units.
 * Index order is (z, y, x): slice, row, column. Slices are sorted by increasing z position.
 */
export interface Volume {
  hu: Int16Array;
  nz: number;
  ny: number;
  nx: number;
  /** Voxel size in mm: slice spacing, row spacing, column spacing. */
  dz: number;
  dy: number;
  dx: number;
  /** DICOM InstanceNumber of each slice, the number a researcher sees in a viewer. */
  sliceNumbers: number[];
  meta: ScanMeta;
}

export interface ScanMeta {
  patientId: string;
  studyDate: string;
  seriesNumber: number;
  sliceThickness: number;
  seriesUid: string;
  seriesDescription: string;
}

/** A binary outline stored as a small box inside the volume. */
export interface Mask {
  data: Uint8Array;
  z0: number;
  y0: number;
  x0: number;
  nz: number;
  ny: number;
  nx: number;
}

export const voxelVolumeMm3 = (v: Volume) => v.dz * v.dy * v.dx;

export function emptyMask(z0: number, y0: number, x0: number, nz: number, ny: number, nx: number): Mask {
  return { data: new Uint8Array(nz * ny * nx), z0, y0, x0, nz, ny, nx };
}

export function maskVoxelCount(m: Mask): number {
  let n = 0;
  for (let i = 0; i < m.data.length; i++) n += m.data[i];
  return n;
}

/** Value of the mask at a voxel given in volume coordinates. */
export function maskAt(m: Mask, z: number, y: number, x: number): number {
  const zz = z - m.z0, yy = y - m.y0, xx = x - m.x0;
  if (zz < 0 || yy < 0 || xx < 0 || zz >= m.nz || yy >= m.ny || xx >= m.nx) return 0;
  return m.data[(zz * m.ny + yy) * m.nx + xx];
}

/** Shrink a mask to the bounding box of its voxels. Returns null when it is empty. */
export function cropMask(m: Mask): Mask | null {
  let z0 = m.nz, y0 = m.ny, x0 = m.nx, z1 = -1, y1 = -1, x1 = -1;
  for (let z = 0, i = 0; z < m.nz; z++)
    for (let y = 0; y < m.ny; y++)
      for (let x = 0; x < m.nx; x++, i++)
        if (m.data[i]) {
          if (z < z0) z0 = z; if (z > z1) z1 = z;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
        }
  if (z1 < 0) return null;
  const out = emptyMask(m.z0 + z0, m.y0 + y0, m.x0 + x0, z1 - z0 + 1, y1 - y0 + 1, x1 - x0 + 1);
  for (let z = 0; z < out.nz; z++)
    for (let y = 0; y < out.ny; y++) {
      const src = ((z + z0) * m.ny + (y + y0)) * m.nx + x0;
      out.data.set(m.data.subarray(src, src + out.nx), (z * out.ny + y) * out.nx);
    }
  return out;
}

/** Copy a mask into a larger box (used before editing so a brush can add voxels). */
export function padMask(m: Mask, v: Volume, pad: number): Mask {
  const z0 = Math.max(m.z0 - pad, 0), y0 = Math.max(m.y0 - pad, 0), x0 = Math.max(m.x0 - pad, 0);
  const z1 = Math.min(m.z0 + m.nz + pad, v.nz), y1 = Math.min(m.y0 + m.ny + pad, v.ny), x1 = Math.min(m.x0 + m.nx + pad, v.nx);
  const out = emptyMask(z0, y0, x0, z1 - z0, y1 - y0, x1 - x0);
  for (let z = 0; z < m.nz; z++)
    for (let y = 0; y < m.ny; y++) {
      const src = (z * m.ny + y) * m.nx;
      const dst = ((z + m.z0 - z0) * out.ny + (y + m.y0 - y0)) * out.nx + (m.x0 - x0);
      out.data.set(m.data.subarray(src, src + m.nx), dst);
    }
  return out;
}

/** Dice overlap of two masks, which may sit in different boxes. */
export function dice(a: Mask, b: Mask): number {
  let inter = 0;
  for (let z = 0, i = 0; z < a.nz; z++)
    for (let y = 0; y < a.ny; y++)
      for (let x = 0; x < a.nx; x++, i++)
        if (a.data[i] && maskAt(b, z + a.z0, y + a.y0, x + a.x0)) inter++;
  const total = maskVoxelCount(a) + maskVoxelCount(b);
  return total ? (2 * inter) / total : 1;
}

export function cloneMask(m: Mask): Mask {
  return { ...m, data: m.data.slice() };
}

/** Return a mask whose box covers the given volume-coordinate range, copying the old voxels. */
function growMaskTo(m: Mask, v: Volume, z0: number, z1: number, y0: number, y1: number, x0: number, x1: number): Mask {
  if (z0 >= m.z0 && y0 >= m.y0 && x0 >= m.x0 && z1 < m.z0 + m.nz && y1 < m.y0 + m.ny && x1 < m.x0 + m.nx) return m;
  const margin = 16;
  const nz0 = Math.max(Math.min(m.z0, z0 - 2), 0), ny0 = Math.max(Math.min(m.y0, y0 - margin), 0), nx0 = Math.max(Math.min(m.x0, x0 - margin), 0);
  const nz1 = Math.min(Math.max(m.z0 + m.nz - 1, z1 + 2), v.nz - 1);
  const ny1 = Math.min(Math.max(m.y0 + m.ny - 1, y1 + margin), v.ny - 1);
  const nx1 = Math.min(Math.max(m.x0 + m.nx - 1, x1 + margin), v.nx - 1);
  const out = emptyMask(nz0, ny0, nx0, nz1 - nz0 + 1, ny1 - ny0 + 1, nx1 - nx0 + 1);
  for (let z = 0; z < m.nz; z++)
    for (let y = 0; y < m.ny; y++) {
      const src = (z * m.ny + y) * m.nx;
      out.data.set(m.data.subarray(src, src + m.nx), ((z + m.z0 - nz0) * out.ny + (y + m.y0 - ny0)) * out.nx + (m.x0 - nx0));
    }
  return out;
}

/**
 * Paint (value 1) or erase (value 0) along a line on slice z with a round brush of radius rMm.
 * With ball = true the brush is a sphere and also touches neighbouring slices.
 * Returns the mask, which is a new, larger object when the brush left the old box.
 */
export function paintLine(m: Mask, v: Volume, z: number, xa: number, ya: number, xb: number, yb: number,
  rMm: number, value: 0 | 1, ball: boolean): Mask {
  const rx = rMm / v.dx, ry = rMm / v.dy, rz = ball ? rMm / v.dz : 0;
  const zLo = Math.max(Math.round(z - rz), 0), zHi = Math.min(Math.round(z + rz), v.nz - 1);
  const clampX = (x: number) => Math.max(0, Math.min(v.nx - 1, x)), clampY = (y: number) => Math.max(0, Math.min(v.ny - 1, y));
  let out = m;
  if (value === 1)
    out = growMaskTo(m, v, zLo, zHi, clampY(Math.floor(Math.min(ya, yb) - ry)), clampY(Math.ceil(Math.max(ya, yb) + ry)),
      clampX(Math.floor(Math.min(xa, xb) - rx)), clampX(Math.ceil(Math.max(xa, xb) + rx)));
  const steps = Math.max(1, Math.ceil(Math.hypot(xb - xa, yb - ya) * 2));
  for (let s = 0; s <= steps; s++) {
    const cx = xa + (xb - xa) * (s / steps), cy = ya + (yb - ya) * (s / steps);
    for (let zz = zLo; zz <= zHi; zz++) {
      const ez = rz ? ((zz - z) * v.dz) / rMm : 0;
      const shrink = Math.sqrt(Math.max(0, 1 - ez * ez));
      if (zz - out.z0 < 0 || zz - out.z0 >= out.nz) continue;
      for (let y = Math.floor(cy - ry * shrink); y <= Math.ceil(cy + ry * shrink); y++) {
        const my = y - out.y0;
        if (my < 0 || my >= out.ny) continue;
        for (let x = Math.floor(cx - rx * shrink); x <= Math.ceil(cx + rx * shrink); x++) {
          const mx = x - out.x0;
          if (mx < 0 || mx >= out.nx) continue;
          const ex = ((x - cx) * v.dx) / rMm, ey = ((y - cy) * v.dy) / rMm;
          if (ex * ex + ey * ey + ez * ez <= 1) out.data[((zz - out.z0) * out.ny + my) * out.nx + mx] = value;
        }
      }
    }
  }
  return out;
}
