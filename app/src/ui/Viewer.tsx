import { useEffect, useRef } from 'react';
import { boxAt } from '../core/boxes.ts';
import type { KeyBox } from '../core/boxes.ts';
import type { Stroke } from '../core/segment.ts';
import type { Volume } from '../core/volume.ts';
import type { Finding, PriorSpot, WindowPreset } from './types.ts';

interface Props {
  volume: Volume;
  slice: number;
  window: WindowPreset;
  findings: Finding[];
  selectedId: number | null;
  /** Expected positions of the prior scan's nodules, drawn as dashed circles. */
  spots: PriorSpot[];
  /** +1 or -1: which way the slice index moves when scrolling down. */
  scrollStep: number;
  /** Boxes drawn for the image model, sorted by slice. */
  boxes: KeyBox[];
  /** outline: drag a line across a tumour. brush / erase: correct the selected outline. box: drag a box for the image model. */
  tool: Tool;
  brushMm: number;
  onSlice: (slice: number) => void;
  onStroke: (stroke: Stroke) => void;
  onBrush: (phase: 'start' | 'move' | 'end', z: number, x: number, y: number) => void;
  onBox: (box: KeyBox) => void;
}

export type Tool = 'outline' | 'brush' | 'erase' | 'box';

interface View { scale: number; ox: number; oy: number }
type Drag =
  | { kind: 'stroke'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'brush' }
  | { kind: 'pan'; lastX: number; lastY: number };

const COLOURS = { suggested: '#fbbf24', signed: '#34d399', selected: '#38bdf8', box: '#a78bfa' };

/** Axial slice viewer: scroll to change slice, drag across a tumour to outline it. */
export function Viewer({ volume, slice, window: win, findings, selectedId, spots, boxes, scrollStep, tool, brushMm, onSlice, onStroke, onBrush, onBox }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ scale: 1, ox: 0, oy: 0 });
  const drag = useRef<Drag | null>(null);
  const sliceImage = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  const hover = useRef<{ x: number; y: number } | null>(null);
  const latest = useRef({ volume, slice, win, findings, selectedId, spots, boxes, scrollStep, tool, brushMm, onSlice, onStroke, onBrush, onBox });
  latest.current = { volume, slice, win, findings, selectedId, spots, boxes, scrollStep, tool, brushMm, onSlice, onStroke, onBrush, onBox };

  const fit = () => {
    const c = canvasRef.current!;
    const scale = Math.min(c.clientWidth / (volume.nx * volume.dx), c.clientHeight / (volume.ny * volume.dy));
    view.current = {
      scale,
      ox: (c.clientWidth - volume.nx * volume.dx * scale) / 2,
      oy: (c.clientHeight - volume.ny * volume.dy * scale) / 2,
    };
  };

  // Screen position of a voxel coordinate, and back. Voxel centres sit at +0.5.
  const toScreen = (x: number, y: number) => {
    const { scale, ox, oy } = view.current, v = latest.current.volume;
    return [ox + (x + 0.5) * v.dx * scale, oy + (y + 0.5) * v.dy * scale] as const;
  };
  const toVoxel = (sx: number, sy: number) => {
    const { scale, ox, oy } = view.current, v = latest.current.volume;
    return [(sx - ox) / (v.dx * scale) - 0.5, (sy - oy) / (v.dy * scale) - 0.5] as const;
  };

  const draw = () => {
    const c = canvasRef.current;
    if (!c) return;
    const { volume: v, slice: z, win: w, findings: fs, selectedId: sel } = latest.current;
    const dpr = globalThis.devicePixelRatio || 1;
    if (c.width !== Math.round(c.clientWidth * dpr) || c.height !== Math.round(c.clientHeight * dpr)) {
      c.width = Math.round(c.clientWidth * dpr);
      c.height = Math.round(c.clientHeight * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.clientWidth, c.clientHeight);

    // Grey-level image of the slice, cached until the slice or window changes.
    const key = `${v.meta.seriesUid}:${z}:${w.center}:${w.width}`;
    if (sliceImage.current?.key !== key) {
      const off = sliceImage.current?.canvas ?? document.createElement('canvas');
      off.width = v.nx; off.height = v.ny;
      const img = new ImageData(v.nx, v.ny);
      const lo = w.center - w.width / 2, k = 255 / w.width, base = z * v.ny * v.nx;
      for (let i = 0, j = 0; i < v.nx * v.ny; i++, j += 4) {
        const g = Math.max(0, Math.min(255, (v.hu[base + i] - lo) * k));
        img.data[j] = img.data[j + 1] = img.data[j + 2] = g;
        img.data[j + 3] = 255;
      }
      off.getContext('2d')!.putImageData(img, 0, 0);
      sliceImage.current = { key, canvas: off };
    }
    const { scale, ox, oy } = view.current;
    const px = v.dx * scale, py = v.dy * scale;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sliceImage.current.canvas, ox, oy, v.nx * px, v.ny * py);

    for (const f of fs) {
      const m = f.mask, zz = z - m.z0;
      if (zz < 0 || zz >= m.nz) continue;
      const colour = f.id === sel ? COLOURS.selected : f.signedOff ? COLOURS.signed : COLOURS.suggested;
      const at = (y: number, x: number) => (y < 0 || x < 0 || y >= m.ny || x >= m.nx ? 0 : m.data[(zz * m.ny + y) * m.nx + x]);
      ctx.fillStyle = colour + '26';
      ctx.strokeStyle = colour;
      ctx.lineWidth = f.id === sel ? 2 : 1.5;
      ctx.beginPath();
      for (let y = 0; y < m.ny; y++)
        for (let x = 0; x < m.nx; x++) {
          if (!at(y, x)) continue;
          const sx = ox + (x + m.x0) * px, sy = oy + (y + m.y0) * py;
          ctx.fillRect(sx, sy, px + 0.5, py + 0.5);
          if (!at(y - 1, x)) { ctx.moveTo(sx, sy); ctx.lineTo(sx + px, sy); }
          if (!at(y + 1, x)) { ctx.moveTo(sx, sy + py); ctx.lineTo(sx + px, sy + py); }
          if (!at(y, x - 1)) { ctx.moveTo(sx, sy); ctx.lineTo(sx, sy + py); }
          if (!at(y, x + 1)) { ctx.moveTo(sx + px, sy); ctx.lineTo(sx + px, sy + py); }
        }
      ctx.stroke();
      // Diameter lines on the slice they were measured on.
      if (f.measurement.sliceIndex === z && f.id === sel) {
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.5;
        for (const a of [f.measurement.longAxis, f.measurement.shortAxis]) {
          if (!a) continue;
          const [ax, ay] = toScreen(a.x0, a.y0), [bx, by] = toScreen(a.x1, a.y1);
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      const [lx, ly] = toScreen(m.x0 + m.nx, m.y0);
      ctx.fillStyle = colour;
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillText(f.fields.noduleId, lx + 4, ly + 4);
    }

    // Where each nodule of the prior scan is expected, shown on the slices its old size spans.
    for (const sp of latest.current.spots) {
      const radius = Math.max(sp.nodule.longAxisMm / 2, 5);
      const off = Math.abs(z - sp.z) * v.dz;
      if (off > radius || sp.notFound) continue;
      const [sx, sy] = toScreen(sp.x, sp.y);
      const r = Math.sqrt(radius * radius - off * off) * scale + 4;
      ctx.strokeStyle = '#e879f9';
      ctx.lineWidth = z === sp.z ? 2 : 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#e879f9';
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillText(`${sp.nodule.noduleId} prior`, sx + r + 4, sy + r);
    }

    // Boxes for the image model: solid where one was drawn, dashed where it is blended from its neighbours.
    const bs = latest.current.boxes, here = boxAt(bs, z);
    if (here) {
      const drawn = bs.some((b) => b.z === z);
      const [ax, ay] = toScreen(here[0] - 0.5, here[1] - 0.5), [bx, by] = toScreen(here[2] + 0.5, here[3] + 0.5);
      ctx.strokeStyle = COLOURS.box;
      ctx.lineWidth = drawn ? 2 : 1;
      ctx.setLineDash(drawn ? [] : [5, 4]);
      ctx.strokeRect(ax, ay, bx - ax, by - ay);
      ctx.setLineDash([]);
      ctx.fillStyle = COLOURS.box;
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillText(drawn ? 'Box' : 'Box (in between)', ax, ay - 5);
    }

    const d = drag.current;
    if (d?.kind === 'box') {
      const [ax, ay] = toScreen(d.x0, d.y0), [bx, by] = toScreen(d.x1, d.y1);
      ctx.strokeStyle = COLOURS.box;
      ctx.lineWidth = 2;
      ctx.strokeRect(ax, ay, bx - ax, by - ay);
    }
    if (d?.kind === 'stroke') {
      const [ax, ay] = toScreen(d.x0, d.y0), [bx, by] = toScreen(d.x1, d.y1);
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      const mm = Math.hypot((d.x1 - d.x0) * v.dx, (d.y1 - d.y0) * v.dy);
      ctx.fillStyle = '#f8fafc';
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.fillText(`${mm.toFixed(1)} mm`, bx + 8, by - 8);
    }
    // Brush outline under the pointer.
    const { tool: t, brushMm: r } = latest.current;
    if ((t === 'brush' || t === 'erase') && hover.current) {
      ctx.strokeStyle = t === 'brush' ? COLOURS.selected : '#f87171';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(hover.current.x, hover.current.y, r * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
  };

  // Fit the image when a scan opens or the panel resizes.
  useEffect(() => {
    fit();
    draw();
    const ro = new ResizeObserver(() => { fit(); draw(); });
    ro.observe(canvasRef.current!);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume]);

  useEffect(draw);

  useEffect(() => {
    const c = canvasRef.current!;
    const pos = (e: MouseEvent) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { volume: v, slice: z, onSlice: go, scrollStep: step } = latest.current;
      if (e.ctrlKey || e.shiftKey) {
        const [sx, sy] = pos(e);
        const [vx, vy] = toVoxel(sx, sy);
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const scale = Math.max(0.2, Math.min(40, view.current.scale * factor));
        view.current = { scale, ox: sx - (vx + 0.5) * v.dx * scale, oy: sy - (vy + 0.5) * v.dy * scale };
        draw();
      } else {
        go(Math.max(0, Math.min(v.nz - 1, z + (e.deltaY > 0 ? step : -step))));
      }
    };
    const onDown = (e: PointerEvent) => {
      const [sx, sy] = pos(e);
      c.setPointerCapture(e.pointerId);
      if (e.button === 0) {
        const [x, y] = toVoxel(sx, sy);
        if (latest.current.tool === 'outline' || latest.current.tool === 'box') {
          drag.current = { kind: latest.current.tool === 'box' ? 'box' : 'stroke', x0: x, y0: y, x1: x, y1: y };
        } else {
          drag.current = { kind: 'brush' };
          latest.current.onBrush('start', latest.current.slice, x, y);
        }
      } else {
        drag.current = { kind: 'pan', lastX: sx, lastY: sy };
      }
    };
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      const [sx, sy] = pos(e);
      hover.current = { x: sx, y: sy };
      if (!d) { if (latest.current.tool === 'brush' || latest.current.tool === 'erase') draw(); return; }
      if (d.kind === 'stroke' || d.kind === 'box') {
        [d.x1, d.y1] = toVoxel(sx, sy);
      } else if (d.kind === 'brush') {
        const [x, y] = toVoxel(sx, sy);
        latest.current.onBrush('move', latest.current.slice, x, y);
      } else {
        view.current.ox += sx - d.lastX; view.current.oy += sy - d.lastY;
        d.lastX = sx; d.lastY = sy;
      }
      draw();
    };
    const onUp = () => {
      const d = drag.current;
      drag.current = null;
      if (d?.kind === 'stroke') latest.current.onStroke({ z: latest.current.slice, x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 });
      if (d?.kind === 'box' && Math.abs(d.x1 - d.x0) > 2 && Math.abs(d.y1 - d.y0) > 2)
        latest.current.onBox({ z: latest.current.slice, x0: Math.min(d.x0, d.x1), y0: Math.min(d.y0, d.y1), x1: Math.max(d.x0, d.x1), y1: Math.max(d.y0, d.y1) });
      if (d?.kind === 'brush') latest.current.onBrush('end', latest.current.slice, 0, 0);
      draw();
    };
    const onLeave = () => { hover.current = null; draw(); };
    const noMenu = (e: Event) => e.preventDefault();
    c.addEventListener('wheel', onWheel, { passive: false });
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('contextmenu', noMenu);
    c.addEventListener('pointerleave', onLeave);
    return () => {
      c.removeEventListener('pointerleave', onLeave);
      c.removeEventListener('wheel', onWheel);
      c.removeEventListener('pointerdown', onDown);
      c.removeEventListener('pointermove', onMove);
      c.removeEventListener('pointerup', onUp);
      c.removeEventListener('contextmenu', noMenu);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={canvasRef} className={`viewer-canvas ${tool === 'brush' || tool === 'erase' ? 'brushing' : ''}`} />;
}
