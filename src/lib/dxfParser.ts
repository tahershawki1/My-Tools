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
  const parserInstance = new DxfParserLib();
  
  // Register Civil 3D (AEC) entity handlers to prevent skipping them
  const aecTypes = [
    'AECC_ALIGNMENT',
    'AECC_COGO_POINT',
    'AECC_TIN_SURFACE',
    'AECC_PARCEL',
    'AECC_PARCEL_SEGMENT',
    'AECC_FEATURE_LINE',
    'AECC_GRID_SURFACE',
    'AECC_SURFACE',
    'AECC_POINT',
    'ACAD_PROXY_ENTITY'
  ];

  for (const typeName of aecTypes) {
    (parserInstance as any)._entityHandlers[typeName] = {
      ForEntityName: typeName,
      parseEntity: (scanner: any, curr: any) => {
        const entity = {
          type: curr.value,
          layer: '0',
          vertices: [] as { x: number; y: number; z: number }[]
        } as any;

        curr = scanner.next();
        let currentPt = { x: 0, y: 0, z: 0 };
        while (!scanner.isEOF()) {
          if (curr.code === 0) break;

          switch (curr.code) {
            case 8: // Layer name
              entity.layer = curr.value;
              break;
            case 10:
              currentPt.x = curr.value;
              let nextGroup = scanner.next();
              if (nextGroup && nextGroup.code === 20) {
                currentPt.y = nextGroup.value;
                let nextNext = scanner.next();
                if (nextNext && nextNext.code === 30) {
                  currentPt.z = nextNext.value;
                } else {
                  scanner.rewind();
                }
              } else {
                scanner.rewind();
              }
              entity.vertices.push({ ...currentPt });
              currentPt = { x: 0, y: 0, z: 0 };
              break;
            case 11:
              if (!entity.vertices11) entity.vertices11 = [];
              currentPt.x = curr.value;
              let nextGroup11 = scanner.next();
              if (nextGroup11 && nextGroup11.code === 21) {
                currentPt.y = nextGroup11.value;
                let nextNext11 = scanner.next();
                if (nextNext11 && nextNext11.code === 31) {
                  currentPt.z = nextNext11.value;
                } else {
                  scanner.rewind();
                }
              } else {
                scanner.rewind();
              }
              entity.vertices11.push({ ...currentPt });
              currentPt = { x: 0, y: 0, z: 0 };
              break;
            default:
              break;
          }
          curr = scanner.next();
        }
        return entity;
      }
    };
  }

  const raw: IDxf | null = parserInstance.parseSync(text);
  const warnings: string[] = [];
  if (!raw) {
    return { segments: [], bounds: null, units: 'unknown', unitsUnknown: true, warnings: ['Failed to parse DXF file.'] };
  }

  const { units, scale, unknown } = resolveUnits(raw.header ?? {});
  const segments: DxfSegment[] = [];
  const skipped = new Map<string, number>();

  // Helper to compose transformations
  type TransformFn = (p: { x: number; y: number }) => { x: number; y: number };

  const composeTransform = (
    parent: TransformFn,
    tx: number,
    ty: number,
    rotDeg: number,
    sx: number,
    sy: number
  ): TransformFn => {
    const rad = (rotDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    return (p: { x: number; y: number }) => {
      // 1. Scale
      const xs = p.x * sx;
      const ys = p.y * sy;
      // 2. Rotate
      const xr = xs * cos - ys * sin;
      const yr = xs * sin + ys * cos;
      // 3. Translate
      const xt = xr + tx;
      const yt = yr + ty;
      // 4. Pass to parent transform
      return parent({ x: xt, y: yt });
    };
  };

  const toMeters = (p: { x: number; y: number }) => ({ x: p.x * scale, y: p.y * scale });

  // Recursive processor for entities
  const processEntities = (
    entitiesList: IEntity[],
    transform: TransformFn,
    visitedBlocks = new Set<string>()
  ) => {
    for (const entity of entitiesList) {
      const layer = entity.layer || '0';
      const type = (entity.type || '').toUpperCase();

      switch (type) {
        case 'LINE': {
          const e = entity as unknown as ILineEntity;
          const [a, b] = e.vertices;
          if (a && b) {
            const p1 = transform({ x: a.x, y: a.y });
            const p2 = transform({ x: b.x, y: b.y });
            segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, layer });
          }
          break;
        }

        case 'LWPOLYLINE': {
          const e = entity as unknown as ILwpolylineEntity;
          const vertices = e.vertices ?? [];
          const closed = !!e.shape;
          const n = vertices.length;
          if (n < 2) break;
          const last = closed ? n : n - 1;
          for (let i = 0; i < last; i++) {
            const a = vertices[i];
            const b = vertices[(i + 1) % n];
            const bulge = a.bulge ?? 0;
            const pts = bulgeToPoints({ x: a.x, y: a.y, z: 0 }, { x: b.x, y: b.y, z: 0 }, bulge);
            for (let j = 0; j < pts.length - 1; j++) {
              const p1 = transform(pts[j]);
              const p2 = transform(pts[j + 1]);
              segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, layer });
            }
          }
          break;
        }

        case 'POLYLINE': {
          const e = entity as unknown as IPolylineEntity;
          if (e.isPolyfaceMesh || e.is3dPolygonMesh) {
            skipped.set('POLYLINE (mesh)', (skipped.get('POLYLINE (mesh)') ?? 0) + 1);
            break;
          }
          const vertices = e.vertices ?? [];
          const closed = !!e.shape;
          const n = vertices.length;
          if (n < 2) break;
          const last = closed ? n : n - 1;
          for (let i = 0; i < last; i++) {
            const a = vertices[i];
            const b = vertices[(i + 1) % n];
            const bulge = a.bulge ?? 0;
            const pts = bulgeToPoints({ x: a.x, y: a.y, z: 0 }, { x: b.x, y: b.y, z: 0 }, bulge);
            for (let j = 0; j < pts.length - 1; j++) {
              const p1 = transform(pts[j]);
              const p2 = transform(pts[j + 1]);
              segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, layer });
            }
          }
          break;
        }

        case 'CIRCLE': {
          const e = entity as unknown as ICircleEntity;
          const pts = arcPoints(e.center.x, e.center.y, e.radius, 0, 2 * Math.PI);
          for (let j = 0; j < pts.length - 1; j++) {
            const p1 = transform(pts[j]);
            const p2 = transform(pts[j + 1]);
            segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, layer });
          }
          break;
        }

        case 'ARC': {
          const e = entity as unknown as IArcEntity;
          let start = e.startAngle * DEG2RAD;
          let end = e.endAngle * DEG2RAD;
          if (end <= start) end += 2 * Math.PI;
          const pts = arcPoints(e.center.x, e.center.y, e.radius, start, end);
          for (let j = 0; j < pts.length - 1; j++) {
            const p1 = transform(pts[j]);
            const p2 = transform(pts[j + 1]);
            segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, layer });
          }
          break;
        }

        case 'ELLIPSE': {
          const e = entity as any;
          const cx = e.center?.x ?? 0;
          const cy = e.center?.y ?? 0;
          const dx = e.majorAxisEndPoint?.x ?? 1;
          const dy = e.majorAxisEndPoint?.y ?? 0;
          const a = Math.hypot(dx, dy);
          const b = a * (e.axisRatio ?? 1);
          const alpha = Math.atan2(dy, dx);
          
          let start = e.startAngle ?? 0;
          let end = e.endAngle ?? (2 * Math.PI);
          if (end <= start) end += 2 * Math.PI;
          
          const sweep = end - start;
          const numSteps = Math.max(16, Math.ceil(Math.abs(sweep) / 0.1));
          const pts: { x: number; y: number }[] = [];
          for (let k = 0; k <= numSteps; k++) {
            const t = start + (sweep * k) / numSteps;
            const xl = a * Math.cos(t);
            const yl = b * Math.sin(t);
            pts.push({
              x: cx + xl * Math.cos(alpha) - yl * Math.sin(alpha),
              y: cy + xl * Math.sin(alpha) + yl * Math.cos(alpha),
            });
          }
          for (let j = 0; j < pts.length - 1; j++) {
            const p1 = transform(pts[j]);
            const p2 = transform(pts[j + 1]);
            segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, layer });
          }
          break;
        }

        case 'SPLINE': {
          const e = entity as any;
          const pts = (e.fitPoints && e.fitPoints.length > 0) ? e.fitPoints : e.controlPoints;
          if (pts && pts.length >= 2) {
            for (let j = 0; j < pts.length - 1; j++) {
              const p1 = transform({ x: pts[j].x, y: pts[j].y });
              const p2 = transform({ x: pts[j + 1].x, y: pts[j + 1].y });
              segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, layer });
            }
          }
          break;
        }

        case 'SOLID':
        case '3DFACE': {
          const e = entity as any;
          const pts = e.points || e.vertices;
          if (pts && pts.length >= 3) {
            for (let j = 0; j < pts.length; j++) {
              const a = pts[j];
              const b = pts[(j + 1) % pts.length];
              const p1 = transform({ x: a.x, y: a.y });
              const p2 = transform({ x: b.x, y: b.y });
              segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, layer });
            }
          }
          break;
        }

        case 'AECC_ALIGNMENT':
        case 'AECC_COGO_POINT':
        case 'AECC_TIN_SURFACE':
        case 'AECC_PARCEL':
        case 'AECC_PARCEL_SEGMENT':
        case 'AECC_FEATURE_LINE':
        case 'AECC_GRID_SURFACE':
        case 'AECC_SURFACE':
        case 'AECC_POINT':
        case 'ACAD_PROXY_ENTITY': {
          const e = entity as any;
          const vertices = e.vertices ?? [];
          const n = vertices.length;
          if (n >= 2) {
            for (let i = 0; i < n - 1; i++) {
              const p1 = transform(vertices[i]);
              const p2 = transform(vertices[i + 1]);
              segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, layer });
            }
            if (type === 'AECC_PARCEL' || type === 'AECC_TIN_SURFACE') {
              const p1 = transform(vertices[n - 1]);
              const p2 = transform(vertices[0]);
              segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, layer });
            }
          } else if (n === 1) {
            const p = transform(vertices[0]);
            const crossSize = 0.25;
            segments.push({ x1: p.x - crossSize, y1: p.y, x2: p.x + crossSize, y2: p.y, layer });
            segments.push({ x1: p.x, y1: p.y - crossSize, x2: p.x, y2: p.y + crossSize, layer });
          }
          break;
        }

        case 'INSERT': {
          const insert = entity as any;
          const blockName = insert.name;
          if (!blockName || !raw.blocks || !raw.blocks[blockName]) {
            skipped.set('INSERT (missing block)', (skipped.get('INSERT (missing block)') ?? 0) + 1);
            break;
          }
          if (visitedBlocks.has(blockName)) {
            break;
          }
          const tx = insert.position?.x ?? 0;
          const ty = insert.position?.y ?? 0;
          const rot = insert.rotation ?? 0;
          const sx = insert.xScale ?? 1;
          const sy = insert.yScale ?? 1;

          const nextTransform = composeTransform(transform, tx, ty, rot, sx, sy);
          const nextVisited = new Set(visitedBlocks);
          nextVisited.add(blockName);

          const block = raw.blocks[blockName];
          if (block && block.entities) {
            processEntities(block.entities, nextTransform, nextVisited);
          }
          break;
        }

        default:
          skipped.set(entity.type, (skipped.get(entity.type) ?? 0) + 1);
      }
    }
  };

  // Run the entities processing starting from top-level entities
  processEntities(raw.entities as IEntity[], toMeters);

  // Fallback 1: if no segments from top-level entities, try Model Space block
  if (segments.length === 0 && raw.blocks) {
    for (const blockName of Object.keys(raw.blocks)) {
      const upperName = blockName.toUpperCase();
      if (upperName === '*MODEL_SPACE' || upperName === 'MODEL_SPACE') {
        const block = raw.blocks[blockName];
        if (block && block.entities && block.entities.length > 0) {
          processEntities(block.entities, toMeters);
        }
      }
    }
  }

  // Fallback 2: if still no segments, check ANY block that is NOT paper space
  if (segments.length === 0 && raw.blocks) {
    for (const blockName of Object.keys(raw.blocks)) {
      const upperName = blockName.toUpperCase();
      if (upperName.includes('PAPER_SPACE') || upperName.includes('PAPER SPACE')) {
        continue;
      }
      const block = raw.blocks[blockName];
      if (block && block.entities && block.entities.length > 0) {
        processEntities(block.entities, toMeters);
      }
    }
  }

  // Fallback 3: last resort, process absolutely everything in raw.blocks
  if (segments.length === 0 && raw.blocks) {
    for (const blockName of Object.keys(raw.blocks)) {
      const block = raw.blocks[blockName];
      if (block && block.entities && block.entities.length > 0) {
        processEntities(block.entities, toMeters);
      }
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
