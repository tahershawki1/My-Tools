import DwgReader from 'dwg-reader';
import type { DxfSegment, DxfParseResult, DxfBounds, DxfUnits } from './dxfParser';

// ── Arc rasterization (copied/reused from dxfParser.ts to keep it self-contained) ──
const SAGITTA_FRACTION = 0.005;
const MAX_ANGLE_STEP = 2 * Math.acos(1 - SAGITTA_FRACTION);
const MIN_ARC_SEGMENTS = 4;
const MAX_ARC_SEGMENTS = 64;

function arcSegmentCount(totalAngleRad: number): number {
  const n = Math.ceil(Math.abs(totalAngleRad) / MAX_ANGLE_STEP);
  return Math.min(MAX_ARC_SEGMENTS, Math.max(MIN_ARC_SEGMENTS, n));
}

function arcPoints(cx: number, cy: number, radius: number, startAngle: number, endAngle: number): { x: number; y: number }[] {
  const sweep = endAngle - startAngle;
  const n = arcSegmentCount(sweep);
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const a = startAngle + (sweep * i) / n;
    pts.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
  }
  return pts;
}

function bulgeToPoints(p1: { x: number; y: number }, p2: { x: number; y: number }, bulge: number): { x: number; y: number }[] {
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

export async function parseDwg(arrayBuffer: ArrayBuffer): Promise<DxfParseResult> {
  const segments: DxfSegment[] = [];
  const warnings: string[] = [];

  try {
    // 1. Initialize DwgReader with locateFile pointing to the public root
    const readerInstance = await new (DwgReader as any)({
      locateFile: (path: string) => {
        if (path.endsWith('.wasm')) {
          return '/reader.wasm';
        }
        return path;
      }
    });

    // 2. Read the DWG binary
    const result = await readerInstance.read(arrayBuffer, { x: 0, y: 0 });
    if (!result || !result.success) {
      throw new Error(result?.msg || 'DwgReader failed to parse the file.');
    }

    const data = result.data || {};
    const entities = data.entities || [];

    // 3. Process entities into standard DxfSegment primitives with a robust transformation pipeline
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

    const identityTransform = (p: { x: number; y: number }) => p;

    const processEntities = (
      entitiesList: any[],
      transform: TransformFn,
      visitedBlocks = new Set<string>()
    ) => {
      for (const entity of entitiesList) {
        const type = (entity.type || '').toUpperCase();
        const layer = entity.layer || '0';

        switch (type) {
          case 'LINE': {
            let x1 = 0, y1 = 0, x2 = 0, y2 = 0, found = false;
            const rawVertices = entity.vertices ?? entity.points ?? [];
            if (Array.isArray(rawVertices) && rawVertices.length >= 2) {
              if (typeof rawVertices[0] === 'object' && rawVertices[0] !== null) {
                x1 = rawVertices[0].x ?? rawVertices[0][0] ?? 0;
                y1 = rawVertices[0].y ?? rawVertices[0][1] ?? 0;
                x2 = rawVertices[1].x ?? rawVertices[1][0] ?? 0;
                y2 = rawVertices[1].y ?? rawVertices[1][1] ?? 0;
                found = true;
              } else if (typeof rawVertices[0] === 'number') {
                x1 = rawVertices[0];
                y1 = rawVertices[1] ?? 0;
                x2 = rawVertices[2] ?? 0;
                y2 = rawVertices[3] ?? 0;
                found = true;
              }
            }
            if (!found) {
              x1 = entity.x1 ?? entity.startX ?? (entity.start?.x) ?? 0;
              y1 = entity.y1 ?? entity.startY ?? (entity.start?.y) ?? 0;
              x2 = entity.x2 ?? entity.endX ?? (entity.end?.x) ?? 0;
              y2 = entity.y2 ?? entity.endY ?? (entity.end?.y) ?? 0;
            }
            const p1 = transform({ x: x1, y: y1 });
            const p2 = transform({ x: x2, y: y2 });
            segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, layer });
            break;
          }

          case 'CIRCLE': {
            const cx = typeof entity.center === 'object' && entity.center !== null ? (entity.center.x ?? 0) : (entity.centerX ?? entity.cx ?? 0);
            const cy = typeof entity.center === 'object' && entity.center !== null ? (entity.center.y ?? 0) : (entity.centerY ?? entity.cy ?? 0);
            const r = entity.radius ?? 0;
            if (r > 0) {
              const pts = arcPoints(cx, cy, r, 0, 2 * Math.PI);
              for (let j = 0; j < pts.length - 1; j++) {
                const p1 = transform(pts[j]);
                const p2 = transform(pts[j + 1]);
                segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, layer });
              }
            }
            break;
          }

          case 'ARC': {
            const cx = typeof entity.center === 'object' && entity.center !== null ? (entity.center.x ?? 0) : (entity.centerX ?? entity.cx ?? 0);
            const cy = typeof entity.center === 'object' && entity.center !== null ? (entity.center.y ?? 0) : (entity.centerY ?? entity.cy ?? 0);
            const r = entity.radius ?? 0;
            let start = entity.start_angle ?? entity.startAngle ?? 0;
            let end = entity.end_angle ?? entity.endAngle ?? 0;

            // Convert degrees to radians if necessary
            if (Math.abs(start) > 2 * Math.PI || Math.abs(end) > 2 * Math.PI) {
              start = (start * Math.PI) / 180;
              end = (end * Math.PI) / 180;
            }

            if (end <= start) end += 2 * Math.PI;

            if (r > 0) {
              const pts = arcPoints(cx, cy, r, start, end);
              for (let j = 0; j < pts.length - 1; j++) {
                const p1 = transform(pts[j]);
                const p2 = transform(pts[j + 1]);
                segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, layer });
              }
            }
            break;
          }

          case 'POLYLINE':
          case 'LWPOLYLINE': {
            const closed = !!(entity.closed ?? entity.shape);
            const pts: { x: number; y: number; bulge?: number }[] = [];
            const rawVertices = entity.vertices ?? entity.points ?? [];

            if (Array.isArray(rawVertices)) {
              if (rawVertices.length > 0) {
                if (typeof rawVertices[0] === 'object' && rawVertices[0] !== null) {
                  for (const v of rawVertices) {
                    const vx = v.x ?? v[0] ?? 0;
                    const vy = v.y ?? v[1] ?? 0;
                    const bulge = v.bulge ?? 0;
                    pts.push({ x: vx, y: vy, bulge });
                  }
                } else if (typeof rawVertices[0] === 'number') {
                  for (let i = 0; i < rawVertices.length; i += 2) {
                    pts.push({ x: rawVertices[i], y: rawVertices[i + 1] ?? 0 });
                  }
                }
              }
            }

            const n = pts.length;
            if (n >= 2) {
              const last = closed ? n : n - 1;
              for (let i = 0; i < last; i++) {
                const a = pts[i];
                const b = pts[(i + 1) % n];
                const bulge = a.bulge ?? 0;
                const subPts = bulgeToPoints(a, b, bulge);
                for (let j = 0; j < subPts.length - 1; j++) {
                  const p1 = transform(subPts[j]);
                  const p2 = transform(subPts[j + 1]);
                  segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, layer });
                }
              }
            }
            break;
          }

          case 'ELLIPSE': {
            const cx = typeof entity.center === 'object' && entity.center !== null ? (entity.center.x ?? 0) : (entity.centerX ?? entity.cx ?? 0);
            const cy = typeof entity.center === 'object' && entity.center !== null ? (entity.center.y ?? 0) : (entity.centerY ?? entity.cy ?? 0);
            
            let dx = 1, dy = 0;
            if (typeof entity.majorAxisEndPoint === 'object' && entity.majorAxisEndPoint !== null) {
              dx = entity.majorAxisEndPoint.x ?? 1;
              dy = entity.majorAxisEndPoint.y ?? 0;
            } else if (typeof entity.major_axis_endpoint === 'object' && entity.major_axis_endpoint !== null) {
              dx = entity.major_axis_endpoint.x ?? 1;
              dy = entity.major_axis_endpoint.y ?? 0;
            } else if (entity.majorX !== undefined || entity.majorY !== undefined) {
              dx = entity.majorX ?? 1;
              dy = entity.majorY ?? 0;
            }

            const a = Math.hypot(dx, dy);
            const b = a * (entity.axisRatio ?? entity.ratio ?? 1);
            const alpha = Math.atan2(dy, dx);
            
            let start = entity.startAngle ?? entity.start_angle ?? 0;
            let end = entity.endAngle ?? entity.end_angle ?? (2 * Math.PI);
            if (end <= start) end += 2 * Math.PI;
            
            const sweep = end - start;
            const numSteps = Math.max(16, Math.ceil(Math.abs(sweep) / 0.1));
            const subPts: { x: number; y: number }[] = [];
            for (let k = 0; k <= numSteps; k++) {
              const t = start + (sweep * k) / numSteps;
              const xl = a * Math.cos(t);
              const yl = b * Math.sin(t);
              subPts.push({
                x: cx + xl * Math.cos(alpha) - yl * Math.sin(alpha),
                y: cy + xl * Math.sin(alpha) + yl * Math.cos(alpha),
              });
            }
            for (let j = 0; j < subPts.length - 1; j++) {
              const p1 = transform(subPts[j]);
              const p2 = transform(subPts[j + 1]);
              segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, layer });
            }
            break;
          }

          case 'SPLINE': {
            const pts = entity.vertices ?? entity.points ?? entity.controlPoints ?? entity.fitPoints ?? [];
            if (Array.isArray(pts) && pts.length >= 2) {
              const validPts: { x: number; y: number }[] = [];
              if (typeof pts[0] === 'object' && pts[0] !== null) {
                for (const v of pts) {
                  validPts.push({ x: v.x ?? v[0] ?? 0, y: v.y ?? v[1] ?? 0 });
                }
              } else if (typeof pts[0] === 'number') {
                for (let i = 0; i < pts.length; i += 2) {
                  validPts.push({ x: pts[i], y: pts[i + 1] ?? 0 });
                }
              }
              for (let j = 0; j < validPts.length - 1; j++) {
                const p1 = transform(validPts[j]);
                const p2 = transform(validPts[j + 1]);
                segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, layer });
              }
            }
            break;
          }

          case 'SOLID':
          case '3DFACE': {
            const pts = entity.points ?? entity.vertices ?? [];
            if (Array.isArray(pts) && pts.length >= 3) {
              const validPts: { x: number; y: number }[] = [];
              if (typeof pts[0] === 'object' && pts[0] !== null) {
                for (const v of pts) {
                  validPts.push({ x: v.x ?? v[0] ?? 0, y: v.y ?? v[1] ?? 0 });
                }
              } else if (typeof pts[0] === 'number') {
                for (let i = 0; i < pts.length; i += 2) {
                  validPts.push({ x: pts[i], y: pts[i + 1] ?? 0 });
                }
              }
              for (let j = 0; j < validPts.length; j++) {
                const p1 = transform(validPts[j]);
                const p2 = transform(validPts[(j + 1) % validPts.length]);
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
            const vertices = entity.vertices ?? entity.points ?? [];
            const pts: { x: number; y: number }[] = [];
            if (Array.isArray(vertices)) {
              if (vertices.length > 0) {
                if (typeof vertices[0] === 'object' && vertices[0] !== null) {
                  for (const v of vertices) {
                    pts.push({ x: v.x ?? v[0] ?? 0, y: v.y ?? v[1] ?? 0 });
                  }
                } else if (typeof vertices[0] === 'number') {
                  for (let i = 0; i < vertices.length; i += 2) {
                    pts.push({ x: vertices[i], y: vertices[i + 1] ?? 0 });
                  }
                }
              }
            }
            const n = pts.length;
            if (n >= 2) {
              for (let i = 0; i < n - 1; i++) {
                const p1 = transform(pts[i]);
                const p2 = transform(pts[i + 1]);
                segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, layer });
              }
              if (type === 'AECC_PARCEL' || type === 'AECC_TIN_SURFACE') {
                const p1 = transform(pts[n - 1]);
                const p2 = transform(pts[0]);
                segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, layer });
              }
            } else if (n === 1) {
              const p = transform(pts[0]);
              const crossSize = 0.25;
              segments.push({ x1: p.x - crossSize, y1: p.y, x2: p.x + crossSize, y2: p.y, layer });
              segments.push({ x1: p.x, y1: p.y - crossSize, x2: p.x, y2: p.y + crossSize, layer });
            }
            break;
          }

          case 'INSERT': {
            const blockName = entity.name ?? entity.blockName;
            if (!blockName || !data.blocks || !data.blocks[blockName]) {
              break;
            }
            if (visitedBlocks.has(blockName)) {
              break;
            }
            const tx = entity.position?.x ?? entity.x ?? 0;
            const ty = entity.position?.y ?? entity.y ?? 0;
            const rot = entity.rotation ?? 0;
            const sx = entity.xScale ?? entity.scaleX ?? 1;
            const sy = entity.yScale ?? entity.scaleY ?? 1;

            const nextTransform = composeTransform(transform, tx, ty, rot, sx, sy);
            const nextVisited = new Set(visitedBlocks);
            nextVisited.add(blockName);

            const block = data.blocks[blockName];
            const blockEntities = block.entities ?? block.objects ?? [];
            if (Array.isArray(blockEntities)) {
              processEntities(blockEntities, nextTransform, nextVisited);
            }
            break;
          }

          default:
            // Ignore unsupported types
            break;
        }
      }
    };

    // Run entities processor
    processEntities(entities, identityTransform);

    // Fallback 1: check Model Space block
    if (segments.length === 0 && data.blocks) {
      for (const blockName of Object.keys(data.blocks)) {
        const upperName = blockName.toUpperCase();
        if (upperName === '*MODEL_SPACE' || upperName === 'MODEL_SPACE') {
          const block = data.blocks[blockName];
          if (block) {
            const blockEntities = block.entities ?? block.objects ?? [];
            if (Array.isArray(blockEntities) && blockEntities.length > 0) {
              processEntities(blockEntities, identityTransform);
            }
          }
        }
      }
    }

    // Fallback 2: check ANY block that is NOT paper space
    if (segments.length === 0 && data.blocks) {
      for (const blockName of Object.keys(data.blocks)) {
        const upperName = blockName.toUpperCase();
        if (upperName.includes('PAPER_SPACE') || upperName.includes('PAPER SPACE')) {
          continue;
        }
        const block = data.blocks[blockName];
        if (block) {
          const blockEntities = block.entities ?? block.objects ?? [];
          if (Array.isArray(blockEntities) && blockEntities.length > 0) {
            processEntities(blockEntities, identityTransform);
          }
        }
      }
    }

    // Fallback 3: last resort, process absolutely everything in data.blocks
    if (segments.length === 0 && data.blocks) {
      for (const blockName of Object.keys(data.blocks)) {
        const block = data.blocks[blockName];
        if (block) {
          const blockEntities = block.entities ?? block.objects ?? [];
          if (Array.isArray(blockEntities) && blockEntities.length > 0) {
            processEntities(blockEntities, identityTransform);
          }
        }
      }
    }

    // 4. Calculate bounds
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    if (segments.length > 0) {
      for (const s of segments) {
        minX = Math.min(minX, s.x1, s.x2); maxX = Math.max(maxX, s.x1, s.x2);
        minY = Math.min(minY, s.y1, s.y2); maxY = Math.max(maxY, s.y1, s.y2);
      }
    }
    const bounds = segments.length > 0 ? { minX, minY, maxX, maxY } : null;

    // Clean up reader resource
    if (typeof readerInstance.destroy === 'function') {
      try {
        readerInstance.destroy();
      } catch (e) {
        // Ignored
      }
    }

    return {
      segments,
      bounds,
      units: 'm' as DxfUnits,
      unitsUnknown: true, // Let the user confirm the units for safety
      warnings
    };

  } catch (err: any) {
    console.error('Error parsing DWG file:', err);
    return {
      segments: [],
      bounds: null,
      units: 'unknown' as DxfUnits,
      unitsUnknown: true,
      warnings: [`Failed to parse DWG file: ${err.message || err}`]
    };
  }
}
