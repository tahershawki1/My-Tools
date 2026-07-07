import DxfParserLib from 'dxf-parser';
import type {
  IDxf, IEntity, IPoint,
  ILineEntity, ILwpolylineEntity, IPolylineEntity, ICircleEntity, IArcEntity,
} from 'dxf-parser';

// ════════════════════════════════════════════════════════════════════════════
//  dxfParser.ts — thin wrapper over the `dxf-parser` npm package.
//
//  Normalizes the handful of entity types a survey site plan actually uses
//  (LINE, LWPOLYLINE/POLYLINE — including bulge arcs, CIRCLE, ARC) into a
//  single flat primitive, DxfSegment, so everything downstream (the CAD
//  canvas renderer, the endpoint/intersection snap search, the spatial index)
//  only ever has to deal with straight line segments. Arcs are rasterized
//  here, at parse time, using a radius-independent chord-height tolerance.
//  Unsupported entities (INSERT blocks, TEXT/MTEXT, SPLINE, DIMENSION, ...)
//  are skipped and summarized into `warnings`, mirroring pdfParser.ts's
//  ParseResult.warnings pattern.
//
//  All coordinates are normalized to meters immediately (from $INSUNITS),
//  so nothing downstream needs to know or care what unit the source DXF used.
// ════════════════════════════════════════════════════════════════════════════

export interface DxfSegment {
  x1: number; y1: number;
  x2: number; y2: number;
  layer: string;
}

export interface DxfBounds {
  minX: number; minY: number;
  maxX: number; maxY: number;
}

export type DxfUnits = 'mm' | 'cm' | 'm' | 'ft' | 'unknown';

export interface DxfParseResult {
  segments: DxfSegment[];
  bounds: DxfBounds | null;
  units: DxfUnits;
  /** True when $INSUNITS was absent/0 — the caller should let the user confirm units. */
  unitsUnknown: boolean;
  warnings: string[];
}

// ── Unit normalization ────────────────────────────────────────────────────────
// DXF $INSUNITS codes (AutoCAD DXF reference) → { label, metersPerUnit }.
// Codes not listed here (rare: microns, astronomical units, ...) fall back to
// 'unknown' with scale 1 (assume meters) and a warning.
const INSUNITS: Record<number, { units: DxfUnits; scale: number }> = {
  1: { units: 'unknown', scale: 0.0254 },  // inches
  2: { units: 'ft', scale: 0.3048 },       // feet
  4: { units: 'mm', scale: 0.001 },        // millimeters
  5: { units: 'cm', scale: 0.01 },         // centimeters
  6: { units: 'm', scale: 1 },             // meters
  14: { units: 'cm', scale: 0.1 },         // decimeters (no dedicated label — closest is cm-ish; scale is exact)
};

function resolveUnits(header: Record<string, IPoint | number>): { units: DxfUnits; scale: number; unknown: boolean } {
  const raw = header['$INSUNITS'];
  const code = typeof raw === 'number' ? raw : 0;
  const found = INSUNITS[code];
  if (found) return { units: found.units, scale: found.scale, unknown: false };
  return { units: 'unknown', scale: 1, unknown: true };
}

// ── Arc rasterization ─────────────────────────────────────────────────────────
// Fixed sagitta-to-radius fraction keeps the max chord-height error at 0.5% of
// the arc's own radius regardless of how big or small that radius is (the R
// cancels out of `1 - cos(step/2) <= fraction`), so tiny survey-plan fillets
// don't waste segments and large arcs stay visually smooth without a
// unit-dependent absolute tolerance.
const SAGITTA_FRACTION = 0.005;
const MAX_ANGLE_STEP = 2 * Math.acos(1 - SAGITTA_FRACTION);
const MIN_ARC_SEGMENTS = 4;
const MAX_ARC_SEGMENTS = 64;

function arcSegmentCount(totalAngleRad: number): number {
  const n = Math.ceil(Math.abs(totalAngleRad) / MAX_ANGLE_STEP);
  return Math.min(MAX_ARC_SEGMENTS, Math.max(MIN_ARC_SEGMENTS, n));
}

/** Points along a circular arc from `center`, `radius`, sweeping `startAngle` → `endAngle` (radians, CCW). */
function arcPoints(cx: number, cy: number, radius: number, startAngle: number, endAngle: number): IPoint[] {
  const sweep = endAngle - startAngle;
  const n = arcSegmentCount(sweep);
  const pts: IPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const a = startAngle + (sweep * i) / n;
    pts.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a), z: 0 });
  }
  return pts;
}

/**
 * Converts a bulge vertex pair into the polyline points approximating the arc
 * between them (inclusive of both endpoints). Bulge = tan(includedAngle/4);
 * sign follows the DXF convention (positive = the arc runs counterclockwise
 * from p1 to p2). Returns [p1, p2] unchanged when bulge is ~0 (straight).
 *
 * Derivation verified by hand for both signs against the DXF spec's
 * "positive bulge = CCW traversal" definition — see the correctness note in
 * the design plan. The center is computed directly from the included angle
 * and chord, so no separate case-analysis on which side the arc bulges is
 * needed: it falls out of the CCW-traversal construction automatically.
 */
function bulgeToPoints(p1: IPoint, p2: IPoint, bulge: number): IPoint[] {
  if (Math.abs(bulge) < 1e-9) return [p1, p2];
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const chordLength = Math.hypot(dx, dy);
  if (chordLength < 1e-9) return [p1, p2];

  const theta = 4 * Math.atan(bulge);
  const signedRadius = chordLength / (2 * Math.sin(theta / 2));
  const radius = Math.abs(signedRadius);
  const chordAngle = Math.atan2(dy, dx);
  const centerAngle = chordAngle + (Math.PI / 2 - theta / 2);
  const cx = p1.x + signedRadius * Math.cos(centerAngle);
  const cy = p1.y + signedRadius * Math.sin(centerAngle);
  const startAngle = Math.atan2(p1.y - cy, p1.x - cx);
  const endAngle = startAngle + theta;
  return arcPoints(cx, cy, radius, startAngle, endAngle);
}

// ── Entity → segments ─────────────────────────────────────────────────────────

function pushPolyline(
  out: DxfSegment[],
  vertices: Array<IPoint & { bulge?: number }>,
  closed: boolean,
  layer: string,
  scale: number,
): void {
  const n = vertices.length;
  if (n < 2) return;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    const bulge = a.bulge ?? 0;
    const pts = bulgeToPoints(a, b, bulge);
    for (let j = 0; j < pts.length - 1; j++) {
      out.push({
        x1: pts[j].x * scale, y1: pts[j].y * scale,
        x2: pts[j + 1].x * scale, y2: pts[j + 1].y * scale,
        layer,
      });
    }
  }
}

const DEG2RAD = Math.PI / 180;

/** Skipped-entity counts, summarized into one warning line per type. */
function summarizeSkips(skipped: Map<string, number>): string[] {
  return [...skipped.entries()].map(([type, count]) =>
    `Skipped ${count} ${type}${count > 1 ? ' entities' : ' entity'} (unsupported in this viewer)`,
  );
}

export function parseDxf(text: string): DxfParseResult {
  const raw: IDxf | null = new DxfParserLib().parseSync(text);
  const warnings: string[] = [];
  if (!raw) {
    return { segments: [], bounds: null, units: 'unknown', unitsUnknown: true, warnings: ['Failed to parse DXF file.'] };
  }

  const { units, scale, unknown } = resolveUnits(raw.header ?? {});
  const segments: DxfSegment[] = [];
  const skipped = new Map<string, number>();

  for (const entity of raw.entities as IEntity[]) {
    const layer = entity.layer || '0';
    switch (entity.type) {
      case 'LINE': {
        const e = entity as unknown as ILineEntity;
        const [a, b] = e.vertices;
        if (a && b) {
          segments.push({ x1: a.x * scale, y1: a.y * scale, x2: b.x * scale, y2: b.y * scale, layer });
        }
        break;
      }
      case 'LWPOLYLINE': {
        const e = entity as unknown as ILwpolylineEntity;
        pushPolyline(segments, e.vertices, !!e.shape, layer, scale);
        break;
      }
      case 'POLYLINE': {
        const e = entity as unknown as IPolylineEntity;
        if (e.isPolyfaceMesh || e.is3dPolygonMesh) {
          skipped.set('POLYLINE (mesh)', (skipped.get('POLYLINE (mesh)') ?? 0) + 1);
          break;
        }
        pushPolyline(segments, e.vertices, !!e.shape, layer, scale);
        break;
      }
      case 'CIRCLE': {
        const e = entity as unknown as ICircleEntity;
        const pts = arcPoints(e.center.x, e.center.y, e.radius, 0, 2 * Math.PI);
        for (let j = 0; j < pts.length - 1; j++) {
          segments.push({
            x1: pts[j].x * scale, y1: pts[j].y * scale,
            x2: pts[j + 1].x * scale, y2: pts[j + 1].y * scale,
            layer,
          });
        }
        break;
      }
      case 'ARC': {
        const e = entity as unknown as IArcEntity;
        let start = e.startAngle * DEG2RAD;
        let end = e.endAngle * DEG2RAD;
        if (end <= start) end += 2 * Math.PI; // DXF arcs always sweep CCW from start to end
        const pts = arcPoints(e.center.x, e.center.y, e.radius, start, end);
        for (let j = 0; j < pts.length - 1; j++) {
          segments.push({
            x1: pts[j].x * scale, y1: pts[j].y * scale,
            x2: pts[j + 1].x * scale, y2: pts[j + 1].y * scale,
            layer,
          });
        }
        break;
      }
      default:
        skipped.set(entity.type, (skipped.get(entity.type) ?? 0) + 1);
    }
  }

  warnings.push(...summarizeSkips(skipped));

  const bounds = resolveBounds(raw.header ?? {}, segments, scale);

  return { segments, bounds, units, unitsUnknown: unknown, warnings };
}

/** Re-scales an already-parsed result to a different unit assumption (e.g. the
 *  user corrects "unknown units" to feet after seeing the drawing). */
export function rescaleParseResult(result: DxfParseResult, factor: number): DxfParseResult {
  if (factor === 1) return result;
  const segments = result.segments.map(s => ({
    x1: s.x1 * factor, y1: s.y1 * factor, x2: s.x2 * factor, y2: s.y2 * factor, layer: s.layer,
  }));
  const bounds = result.bounds && {
    minX: result.bounds.minX * factor, minY: result.bounds.minY * factor,
    maxX: result.bounds.maxX * factor, maxY: result.bounds.maxY * factor,
  };
  return { ...result, segments, bounds };
}

function resolveBounds(
  header: Record<string, IPoint | number>,
  segments: DxfSegment[],
  scale: number,
): DxfBounds | null {
  const extmin = header['$EXTMIN'];
  const extmax = header['$EXTMAX'];
  // AutoCAD sometimes writes sentinel placeholder extents (huge magnitude,
  // min > max) when the file's extents were never recomputed — reject those
  // rather than zooming the CAD canvas out to nothing.
  if (
    extmin && typeof extmin === 'object' && extmax && typeof extmax === 'object' &&
    Number.isFinite(extmin.x) && Number.isFinite(extmin.y) &&
    Number.isFinite(extmax.x) && Number.isFinite(extmax.y) &&
    Math.abs(extmin.x) < 1e15 && Math.abs(extmin.y) < 1e15 &&
    Math.abs(extmax.x) < 1e15 && Math.abs(extmax.y) < 1e15 &&
    extmin.x < extmax.x && extmin.y < extmax.y
  ) {
    return {
      minX: extmin.x * scale, minY: extmin.y * scale,
      maxX: extmax.x * scale, maxY: extmax.y * scale,
    };
  }

  if (segments.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segments) {
    minX = Math.min(minX, s.x1, s.x2); maxX = Math.max(maxX, s.x1, s.x2);
    minY = Math.min(minY, s.y1, s.y2); maxY = Math.max(maxY, s.y1, s.y2);
  }
  return { minX, minY, maxX, maxY };
}
