import type { DxfSegment, DxfBounds } from './dxfParser';

// ════════════════════════════════════════════════════════════════════════════
//  dxfCanvas.ts — the CAD 2D view/interaction engine (library, generic).
//
//  A DxfCanvas owns a <canvas>, the world↔screen view transform, pan/zoom
//  input handling, and the endpoint/intersection snap search. It is a "dumb"
//  renderer: it draws whatever DxfScene it's given and reports picks via a
//  callback — it has no idea what a "measurement" or a "georeference point"
//  is, no wizard-step state, and never imports dxf-parser or the tool file.
//  This mirrors how mapBlock.ts doesn't know what a SignPoint is.
//
//  World space is DXF drawing space (meters, Y-up, after dxfParser.ts has
//  already normalized units/flattened arcs into segments). Screen space is
//  CSS logical pixels with Y-down, origin top-left of the canvas element.
// ════════════════════════════════════════════════════════════════════════════

export interface DxfPoint { x: number; y: number }

export interface DimensionLine {
  p1: DxfPoint;
  p2: DxfPoint;
  distance: number;
  bearingDeg: number;
}

export interface LabeledPoint {
  x: number;
  y: number;
  label: string;
}

export type SnapMode = 'endpoint' | 'intersection' | 'both';

export type SnapResult =
  | { kind: 'endpoint'; x: number; y: number }
  | { kind: 'intersection'; x: number; y: number };

export interface DxfScene {
  segments: DxfSegment[];
  dimensions: DimensionLine[];
  extractedPoints: LabeledPoint[];
  refPoints: LabeledPoint[];
}

export type QuerySegmentsFn = (x: number, y: number, radiusWorld: number) => DxfSegment[];

export interface DxfCanvasOptions {
  /** Spatial-index lookup, owned by the caller (dxfTool.ts), so this engine
   *  never has to know how the whole-drawing segment list is organized. */
  querySegments: QuerySegmentsFn;
  /** Fired on a genuine click (pointerdown+up with negligible movement — a
   *  drag pans instead). The caller decides what a pick means (measurement
   *  point, extraction, georeference reference point, or nothing). */
  onPick?: (world: DxfPoint, snap: SnapResult | null) => void;
  /** Fired after pan/zoom so the caller can update a scale/zoom readout. */
  onViewChange?: (scale: number) => void;
}

const ENDPOINT_PX = 10;
const INTERSECTION_PX = 13;
const DRAG_THRESHOLD_PX = 4;
const MIN_SCALE = 1e-3;
const MAX_SCALE = 1e6;

function readToken(el: Element, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/** Standard 2D segment-segment intersection (parametric form). Returns the
 *  intersection point only when it falls within both segments (0≤t,u≤1). */
function segmentIntersection(a: DxfSegment, b: DxfSegment): DxfPoint | null {
  const d = (a.x2 - a.x1) * (b.y2 - b.y1) - (a.y2 - a.y1) * (b.x2 - b.x1);
  if (Math.abs(d) < 1e-9) return null; // parallel or collinear
  const t = ((b.x1 - a.x1) * (b.y2 - b.y1) - (b.y1 - a.y1) * (b.x2 - b.x1)) / d;
  const u = ((b.x1 - a.x1) * (a.y2 - a.y1) - (b.y1 - a.y1) * (a.x2 - a.x1)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x1 + t * (a.x2 - a.x1), y: a.y1 + t * (a.y2 - a.y1) };
}

export class DxfCanvas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private opts: DxfCanvasOptions;
  private resizeObserver: ResizeObserver;

  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private snapMode: SnapMode = 'both';

  private scene: DxfScene = { segments: [], dimensions: [], extractedPoints: [], refPoints: [] };
  private liveSnap: SnapResult | null = null;
  private renderScheduled = false;
  private destroyed = false;

  private dragging = false;
  private dragMoved = false;
  private dragStartScreen = { x: 0, y: 0 };
  private dragStartOffset = { x: 0, y: 0 };
  private activePointerId: number | null = null;

  constructor(canvasEl: HTMLCanvasElement, opts: DxfCanvasOptions) {
    this.canvas = canvasEl;
    this.opts = opts;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvasEl);
    this.resize();

    canvasEl.addEventListener('wheel', this.handleWheel, { passive: false });
    canvasEl.addEventListener('pointerdown', this.handlePointerDown);
    canvasEl.addEventListener('pointermove', this.handlePointerMove);
    canvasEl.addEventListener('pointerup', this.handlePointerUp);
    canvasEl.addEventListener('pointercancel', this.handlePointerUp);
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('wheel', this.handleWheel);
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerUp);
  }

  // ── Scene / view ──────────────────────────────────────────────────────────

  setScene(scene: DxfScene): void {
    this.scene = scene;
    this.requestRender();
  }

  setSnapMode(mode: SnapMode): void {
    this.snapMode = mode;
  }

  getSnapMode(): SnapMode {
    return this.snapMode;
  }

  getScale(): number {
    return this.scale;
  }

  zoomIn(): void { this.zoomAtCenter(1.5); }
  zoomOut(): void { this.zoomAtCenter(1 / 1.5); }

  private zoomAtCenter(factor: number): void {
    const cw = this.cssWidth();
    const ch = this.cssHeight();
    const cx = cw / 2, cy = ch / 2;
    const before = this.screenToWorld(cx, cy);
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
    this.offsetX = cx - before.x * this.scale;
    this.offsetY = (ch - cy) - before.y * this.scale;
    this.requestRender();
    this.opts.onViewChange?.(this.scale);
  }

  zoomExtents(bounds: DxfBounds): void {
    const w = Math.max(bounds.maxX - bounds.minX, 1e-6);
    const h = Math.max(bounds.maxY - bounds.minY, 1e-6);
    const cw = this.cssWidth();
    const ch = this.cssHeight();
    if (cw === 0 || ch === 0) return;
    this.scale = Math.min(cw / w, ch / h) * 0.92;
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale));
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    // worldToScreen(cx,cy) should land at the canvas center.
    this.offsetX = cw / 2 - cx * this.scale;
    this.offsetY = ch / 2 - cy * this.scale;
    this.requestRender();
    this.opts.onViewChange?.(this.scale);
  }

  screenToWorld(sx: number, sy: number): DxfPoint {
    const ch = this.cssHeight();
    return {
      x: (sx - this.offsetX) / this.scale,
      y: (ch - sy - this.offsetY) / this.scale,
    };
  }

  private worldToScreen(x: number, y: number): DxfPoint {
    const ch = this.cssHeight();
    return { x: x * this.scale + this.offsetX, y: ch - (y * this.scale + this.offsetY) };
  }

  // ── Sizing (DPR-correct) ─────────────────────────────────────────────────────

  private cssWidth(): number { return this.canvas.clientWidth; }
  private cssHeight(): number { return this.canvas.clientHeight; }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.cssWidth();
    const h = this.cssHeight();
    const targetW = Math.max(1, Math.round(w * dpr));
    const targetH = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
    this.requestRender();
  }

  // ── Input: wheel zoom (cursor-centered) ───────────────────────────────────────

  private handleWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const before = this.screenToWorld(sx, sy);

    const factor = Math.pow(1.0015, -e.deltaY);
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));

    // Re-derive offsets so `before` stays under the cursor after rescaling.
    const ch = this.cssHeight();
    this.offsetX = sx - before.x * this.scale;
    this.offsetY = (ch - sy) - before.y * this.scale;

    this.requestRender();
    this.opts.onViewChange?.(this.scale);
  };

  // ── Input: drag-to-pan / click-to-pick (Pointer Events) ───────────────────────

  private handlePointerDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture(e.pointerId);
    this.activePointerId = e.pointerId;
    this.dragging = true;
    this.dragMoved = false;
    this.dragStartScreen = { x: e.clientX, y: e.clientY };
    this.dragStartOffset = { x: this.offsetX, y: this.offsetY };
  };

  private handlePointerMove = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (this.dragging && e.pointerId === this.activePointerId) {
      const dx = e.clientX - this.dragStartScreen.x;
      const dy = e.clientY - this.dragStartScreen.y;
      if (!this.dragMoved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) this.dragMoved = true;
      if (this.dragMoved) {
        this.offsetX = this.dragStartOffset.x + dx;
        this.offsetY = this.dragStartOffset.y - dy; // screen Y grows downward, world Y grows upward
        this.requestRender();
        this.opts.onViewChange?.(this.scale);
        return; // don't also recompute the snap glyph mid-drag
      }
    }

    const world = this.screenToWorld(sx, sy);
    this.liveSnap = findSnap(world.x, world.y, this.scale, this.snapMode, this.opts.querySegments);
    this.requestRender();
  };

  private handlePointerUp = (e: PointerEvent): void => {
    if (e.pointerId === this.activePointerId) {
      this.canvas.releasePointerCapture(e.pointerId);
      const wasClick = this.dragging && !this.dragMoved;
      this.dragging = false;
      this.activePointerId = null;
      if (wasClick) {
        const rect = this.canvas.getBoundingClientRect();
        const world = this.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
        const snap = findSnap(world.x, world.y, this.scale, this.snapMode, this.opts.querySegments);
        this.opts.onPick?.(snap ? { x: snap.x, y: snap.y } : world, snap);
      }
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  private requestRender(): void {
    if (this.renderScheduled || this.destroyed) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      if (!this.destroyed) this.render();
    });
  }

  private render(): void {
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = this.cssWidth();
    const h = this.cssHeight();

    ctx.fillStyle = readToken(this.canvas, '--surface', '#ffffff');
    ctx.fillRect(0, 0, w, h);

    // Segments — one batched path for the whole drawing (single colour, v1).
    ctx.strokeStyle = readToken(this.canvas, '--text', '#1a202c');
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (const s of this.scene.segments) {
      const p1 = this.worldToScreen(s.x1, s.y1);
      const p2 = this.worldToScreen(s.x2, s.y2);
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
    }
    ctx.stroke();

    // Dimensions
    const accent = readToken(this.canvas, '--accent', '#2563eb');
    ctx.strokeStyle = accent;
    ctx.fillStyle = accent;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const d of this.scene.dimensions) {
      const p1 = this.worldToScreen(d.p1.x, d.p1.y);
      const p2 = this.worldToScreen(d.p2.x, d.p2.y);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      this.drawTick(p1, p2, 5);
      this.drawTick(p2, p1, 5);
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      const label = `${d.distance.toFixed(2)} m  ${d.bearingDeg.toFixed(1)}°`;
      ctx.fillStyle = readToken(this.canvas, '--surface', '#ffffff');
      const tw = ctx.measureText(label).width;
      ctx.fillRect(mx - tw / 2 - 3, my - 15, tw + 6, 15);
      ctx.fillStyle = accent;
      ctx.fillText(label, mx, my - 4);
    }

    // Extracted points
    const success = readToken(this.canvas, '--success', '#16a34a');
    this.drawLabeledPoints(this.scene.extractedPoints, success);

    // Reference points (georeferencing)
    const danger = readToken(this.canvas, '--danger', '#dc2626');
    this.drawLabeledPoints(this.scene.refPoints, danger);

    // Live snap glyph
    if (this.liveSnap) {
      const p = this.worldToScreen(this.liveSnap.x, this.liveSnap.y);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      if (this.liveSnap.kind === 'endpoint') {
        ctx.strokeRect(p.x - 6, p.y - 6, 12, 12);
      } else {
        ctx.beginPath();
        ctx.moveTo(p.x - 7, p.y - 7); ctx.lineTo(p.x + 7, p.y + 7);
        ctx.moveTo(p.x + 7, p.y - 7); ctx.lineTo(p.x - 7, p.y + 7);
        ctx.stroke();
      }
    }
  }

  private drawTick(at: DxfPoint, towards: DxfPoint, len: number): void {
    const ctx = this.ctx;
    const dx = towards.x - at.x, dy = towards.y - at.y;
    const d = Math.hypot(dx, dy) || 1;
    const px = -dy / d, py = dx / d; // perpendicular
    ctx.beginPath();
    ctx.moveTo(at.x - px * len, at.y - py * len);
    ctx.lineTo(at.x + px * len, at.y + py * len);
    ctx.stroke();
  }

  private drawLabeledPoints(points: LabeledPoint[], color: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const pt of points) {
      const p = this.worldToScreen(pt.x, pt.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (pt.label) {
        ctx.fillStyle = color;
        ctx.fillText(pt.label, p.x, p.y - 10);
      }
    }
  }
}

// ── Snap search (pure geometry) ─────────────────────────────────────────────────

export function findSnap(
  worldX: number, worldY: number, scale: number, mode: SnapMode, query: QuerySegmentsFn,
): SnapResult | null {
  const endpointRadiusWorld = ENDPOINT_PX / scale;
  const intersectionRadiusWorld = INTERSECTION_PX / scale;

  let bestEndpoint: { x: number; y: number; distPx: number } | null = null;
  let bestIntersection: { x: number; y: number; distPx: number } | null = null;

  if (mode === 'endpoint' || mode === 'both') {
    const candidates = query(worldX, worldY, endpointRadiusWorld);
    for (const seg of candidates) {
      for (const [ex, ey] of [[seg.x1, seg.y1], [seg.x2, seg.y2]] as const) {
        const dPx = Math.hypot(ex - worldX, ey - worldY) * scale;
        if (dPx <= ENDPOINT_PX && (!bestEndpoint || dPx < bestEndpoint.distPx)) {
          bestEndpoint = { x: ex, y: ey, distPx: dPx };
        }
      }
    }
  }

  if (mode === 'intersection' || mode === 'both') {
    const candidates = query(worldX, worldY, intersectionRadiusWorld);
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const pt = segmentIntersection(candidates[i], candidates[j]);
        if (!pt) continue;
        const dPx = Math.hypot(pt.x - worldX, pt.y - worldY) * scale;
        if (dPx <= INTERSECTION_PX && (!bestIntersection || dPx < bestIntersection.distPx)) {
          bestIntersection = { x: pt.x, y: pt.y, distPx: dPx };
        }
      }
    }
  }

  // Nearest of either type wins; ties (equal screen distance) favour endpoint.
  if (bestEndpoint && (!bestIntersection || bestEndpoint.distPx <= bestIntersection.distPx)) {
    return { kind: 'endpoint', x: bestEndpoint.x, y: bestEndpoint.y };
  }
  if (bestIntersection) {
    return { kind: 'intersection', x: bestIntersection.x, y: bestIntersection.y };
  }
  return null;
}
