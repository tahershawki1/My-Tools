import L from 'leaflet';
import proj4 from 'proj4';
import { parseDxf, rescaleParseResult, type DxfParseResult, type DxfSegment, type DxfBounds, type DxfUnits } from './dxfParser';
import { parseDwg } from './dwgParser';
import { DxfCanvas, type SnapMode, type SnapResult, type DxfPoint } from './dxfCanvas';
import { MapBlock } from './mapBlock';
import { DLTM_DEF } from './mapView';
import { utmToDecimal, decimalToUtm, dltmToDecimal, decimalToDltm } from './locationMap';
import { exportDxfPointsCsv, exportDxfPointsJson } from './exporter';

// ════════════════════════════════════════════════════════════════════════════
//  dxfTool.ts — the DXF Site-Plan tool. Owns ALL of its own state and DOM
//  wiring for its own view (upload → CAD canvas → georeference → map verify),
//  delegating rendering to two library pieces: dxfParser.ts (file → segments)
//  and dxfCanvas.ts (segments → pixels + pan/zoom/snap). The map-verification
//  step reuses MapBlock exactly like Point Signing / Location Map do.
//
//  main.ts only toggles this tool's outer view visibility and lazy-loads this
//  module; everything else — canvas events, snapping, measurement,
//  georeferencing math, session persistence — lives here, per the project's
//  explicit "one file owns one tool's data" convention.
// ════════════════════════════════════════════════════════════════════════════

// ── Domain types ──────────────────────────────────────────────────────────────

export type DxfStep = 'upload' | 'cad' | 'georef' | 'map';
type InteractionMode = 'idle' | 'measure' | 'extract' | 'georef-pick';
type CoordFmt = 'dd' | 'utm' | 'dltm' | 'local';

export interface ExtractedPoint {
  id: number;
  x: number; y: number;
  snapKind: 'endpoint' | 'intersection' | 'manual';
  label: string;
  realEasting?: number; realNorthing?: number;
  lat?: number; lng?: number;
}

export interface DimensionRecord {
  id: number;
  p1: DxfPoint; p2: DxfPoint;
  distance: number;
  bearingDeg: number;
}

interface RefEntry {
  drawing: DxfPoint | null;
  targetLatLng: { lat: number; lng: number } | null;
  targetLocal: { E: number; N: number } | null;
  targetLabel: string;
  preferDltm: boolean;
}

function emptyRef(): RefEntry {
  return { drawing: null, targetLatLng: null, targetLocal: null, targetLabel: '', preferDltm: false };
}

export interface GeoTransform {
  scale: number;
  thetaRad: number;
  originDrawing: DxfPoint;
  originTarget: { E: number; N: number };
  crs: { kind: 'utm'; zone: number; south: boolean } | { kind: 'dltm' } | { kind: 'local' };
}

// ── Spatial grid (endpoint/intersection snap acceleration) ─────────────────────

interface SpatialGrid { cellSize: number; cells: Map<string, DxfSegment[]> }

function buildGrid(segments: DxfSegment[], bounds: DxfBounds | null): SpatialGrid {
  const w = bounds ? bounds.maxX - bounds.minX : 100;
  const h = bounds ? bounds.maxY - bounds.minY : 100;
  const cellSize = Math.max(Math.max(w, h) / 64, 0.5);
  const cells = new Map<string, DxfSegment[]>();
  const insert = (cx: number, cy: number, seg: DxfSegment): void => {
    const k = `${cx},${cy}`;
    let arr = cells.get(k);
    if (!arr) { arr = []; cells.set(k, arr); }
    arr.push(seg);
  };
  for (const seg of segments) {
    const minCx = Math.floor(Math.min(seg.x1, seg.x2) / cellSize);
    const maxCx = Math.floor(Math.max(seg.x1, seg.x2) / cellSize);
    const minCy = Math.floor(Math.min(seg.y1, seg.y2) / cellSize);
    const maxCy = Math.floor(Math.max(seg.y1, seg.y2) / cellSize);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) insert(cx, cy, seg);
    }
  }
  return { cellSize, cells };
}

function queryGrid(grid: SpatialGrid, x: number, y: number, radius: number): DxfSegment[] {
  const minCx = Math.floor((x - radius) / grid.cellSize);
  const maxCx = Math.floor((x + radius) / grid.cellSize);
  const minCy = Math.floor((y - radius) / grid.cellSize);
  const maxCy = Math.floor((y + radius) / grid.cellSize);
  const seen = new Set<DxfSegment>();
  const out: DxfSegment[] = [];
  for (let cx = minCx; cx <= maxCx; cx++) {
    for (let cy = minCy; cy <= maxCy; cy++) {
      const arr = grid.cells.get(`${cx},${cy}`);
      if (!arr) continue;
      for (const s of arr) if (!seen.has(s)) { seen.add(s); out.push(s); }
    }
  }
  return out;
}

// ── Module state ─────────────────────────────────────────────────────────────

let step: DxfStep = 'upload';
let mode: InteractionMode = 'idle';
let snapMode: SnapMode = 'both';
let parseResult: DxfParseResult | null = null;
let rawDxfText = '';
let sourceFileName = '';
let grid: SpatialGrid | null = null;
let canvas: DxfCanvas | null = null;
let mapBlock: MapBlock | null = null;
let overlayGroup: L.LayerGroup | null = null;

let pendingMeasureP1: DxfPoint | null = null;
let nextExtractId = 1;
let nextDimId = 1;
let extractedPoints: ExtractedPoint[] = [];
let dimensions: DimensionRecord[] = [];
let refs: [RefEntry, RefEntry] = [emptyRef(), emptyRef()];
let georefPickIndex: 0 | 1 = 0;
let refFmt: [CoordFmt, CoordFmt] = ['dd', 'dd'];
let transform: GeoTransform | null = null;

let _onChange: (() => void) | null = null;
export function onDxfChange(cb: () => void): void { _onChange = cb; }
function notify(): void { _onChange?.(); }

// ── Session persistence (mirrors pointSigning.ts) ───────────────────────────────

const SESSION_KEY = 'survey-dxf-tool-session-v1';

interface PersistedDxfSession {
  rawDxfText: string;
  sourceFileName: string;
  step: DxfStep;
  refs: [RefEntry, RefEntry];
  extractedPoints: ExtractedPoint[];
  dimensions: DimensionRecord[];
  nextExtractId: number;
  nextDimId: number;
}

function persistSession(): void {
  try {
    if (!rawDxfText) { localStorage.removeItem(SESSION_KEY); return; }
    const payload: PersistedDxfSession = {
      rawDxfText, sourceFileName, step, refs, extractedPoints, dimensions, nextExtractId, nextDimId,
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  } catch { /* storage full/unavailable — session just won't survive a reload */ }
}

export function hasPersistedSession(): boolean {
  try { return localStorage.getItem(SESSION_KEY) !== null; } catch { return false; }
}

export function getPersistedSummary(): { fileName: string; step: DxfStep; extracted: number; dimensions: number } | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PersistedDxfSession;
    if (!data.rawDxfText) return null;
    return { fileName: data.sourceFileName, step: data.step, extracted: data.extractedPoints.length, dimensions: data.dimensions.length };
  } catch { return null; }
}

export function restorePersistedSession(): boolean {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw) as PersistedDxfSession;
    if (!data.rawDxfText) return false;
    
    let result: DxfParseResult;
    if (data.rawDxfText.trim().startsWith('{')) {
      result = JSON.parse(data.rawDxfText);
    } else {
      result = parseDxf(data.rawDxfText);
    }
    
    rawDxfText = data.rawDxfText;
    sourceFileName = data.sourceFileName;
    parseResult = result;
    grid = buildGrid(result.segments, result.bounds);
    refs = data.refs;
    extractedPoints = data.extractedPoints;
    dimensions = data.dimensions;
    nextExtractId = data.nextExtractId;
    nextDimId = data.nextDimId;
    step = data.step;
    if (step === 'map') computeTransformFromResolvedRefs();
    return true;
  } catch { return false; }
}

export function clearPersistedSession(): void {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

// ── File loading / units ─────────────────────────────────────────────────────

const UNIT_TO_METERS: Record<DxfUnits, number> = { mm: 0.001, cm: 0.01, m: 1, ft: 0.3048, unknown: 1 };

export async function handleFile(file: File): Promise<{ ok: true } | { ok: false; error: string }> {
  const lower = file.name.toLowerCase();
  let result: DxfParseResult;
  let text = '';

  if (lower.endsWith('.dxf')) {
    text = await file.text();
    result = parseDxf(text);
  } else if (lower.endsWith('.dwg')) {
    const buffer = await file.arrayBuffer();
    result = await parseDwg(buffer);
    text = JSON.stringify(result);
  } else {
    return { ok: false, error: 'Please upload a .dxf or .dwg file.' };
  }

  if (result.segments.length === 0) {
    let msg = 'No supported drawing entities found. Make sure your file contains visible lines, polylines, circles, arcs, ellipses, splines, or solids.';
    if (result.warnings && result.warnings.length > 0) {
      msg += ' ' + result.warnings.join('; ') + '.';
    }
    return { ok: false, error: msg };
  }
  rawDxfText = text;
  sourceFileName = file.name;
  parseResult = result;
  grid = buildGrid(result.segments, result.bounds);
  extractedPoints = [];
  dimensions = [];
  refs = [emptyRef(), emptyRef()];
  transform = null;
  nextExtractId = 1;
  nextDimId = 1;
  step = 'cad';
  persistSession();
  return { ok: true };
}

export function confirmUnits(unit: Exclude<DxfUnits, 'unknown'>): void {
  if (!parseResult) return;
  const factor = UNIT_TO_METERS[unit]; // parseResult is currently scale=1 (assumed meters)
  const rescaled = rescaleParseResult(parseResult, factor);
  parseResult = { ...rescaled, units: unit, unitsUnknown: false };
  grid = buildGrid(parseResult.segments, parseResult.bounds);
  renderCadScene();
  if (parseResult.bounds) canvas?.zoomExtents(parseResult.bounds);
  persistSession();
  notify();
}

export function getUnitsUnknown(): boolean { return parseResult?.unitsUnknown ?? false; }
export function getWarnings(): string[] { return parseResult?.warnings ?? []; }
export function getSourceFileName(): string { return sourceFileName; }
export function getStep(): DxfStep { return step; }
export function getMode(): InteractionMode { return mode; }
export function getSnapMode(): SnapMode { return snapMode; }
export function getExtractedPoints(): ExtractedPoint[] { return extractedPoints; }
export function getDimensions(): DimensionRecord[] { return dimensions; }
export function getRefs(): readonly [RefEntry, RefEntry] { return refs; }

// ── Reset (tool-level "back", mirrors pointSigning's resetSession) ─────────────
// Clears in-memory view state only — a persisted session (if any) survives so
// the next visit can offer to resume it, exactly like Point Signing.

export function resetSession(): void {
  step = 'upload';
  mode = 'idle';
  pendingMeasureP1 = null;
  rawDxfText = '';
  sourceFileName = '';
  parseResult = null;
  grid = null;
  extractedPoints = [];
  dimensions = [];
  refs = [emptyRef(), emptyRef()];
  transform = null;
  refFmt = ['dd', 'dd'];
}

// ── CAD canvas ────────────────────────────────────────────────────────────────

export function initCadCanvas(canvasEl: HTMLCanvasElement): void {
  if (canvas) return;
  canvas = new DxfCanvas(canvasEl, {
    querySegments: (x, y, r) => (grid ? queryGrid(grid, x, y, r) : []),
    onPick: handlePick,
  });
  renderCadScene();
}

export function invalidateCadCanvas(): void {
  if (canvas && parseResult?.bounds) canvas.zoomExtents(parseResult.bounds);
}

export function zoomExtents(): void {
  if (canvas && parseResult?.bounds) canvas.zoomExtents(parseResult.bounds);
}

export function zoomIn(): void { canvas?.zoomIn(); }
export function zoomOut(): void { canvas?.zoomOut(); }

export function setInteractionMode(next: InteractionMode): void {
  mode = next;
  pendingMeasureP1 = null;
  if (next !== 'georef-pick') georefPickIndex = 0;
  notify();
}

export function setSnapMode(next: SnapMode): void {
  snapMode = next;
  canvas?.setSnapMode(next);
  notify();
}

function renderCadScene(): void {
  if (!canvas || !parseResult) return;
  canvas.setScene({
    segments: parseResult.segments,
    dimensions: dimensions.map(d => ({ p1: d.p1, p2: d.p2, distance: d.distance, bearingDeg: d.bearingDeg })),
    extractedPoints: extractedPoints.map(p => ({ x: p.x, y: p.y, label: p.label })),
    refPoints: refs.flatMap((r, i) => (r.drawing ? [{ x: r.drawing.x, y: r.drawing.y, label: `Ref ${i + 1}` }] : [])),
  });
}

function bearingDeg(from: DxfPoint, to: DxfPoint): number {
  // Surveying convention: bearing measured clockwise from North (+Y), matching
  // how the rest of the app already thinks in Northing/Easting.
  const dx = to.x - from.x, dy = to.y - from.y;
  return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
}

function handlePick(world: DxfPoint, snap: SnapResult | null): void {
  const snapKind: ExtractedPoint['snapKind'] = snap ? snap.kind : 'manual';
  switch (mode) {
    case 'idle':
      break;
    case 'measure':
      if (!pendingMeasureP1) {
        pendingMeasureP1 = world;
      } else {
        const p1 = pendingMeasureP1;
        dimensions.push({
          id: nextDimId++, p1, p2: world,
          distance: Math.hypot(world.x - p1.x, world.y - p1.y),
          bearingDeg: bearingDeg(p1, world),
        });
        pendingMeasureP1 = null;
        persistSession();
      }
      break;
    case 'extract':
      extractedPoints.push({ id: nextExtractId, x: world.x, y: world.y, snapKind, label: `P${nextExtractId}` });
      nextExtractId++;
      persistSession();
      break;
    case 'georef-pick':
      refs[georefPickIndex] = { ...refs[georefPickIndex], drawing: world };
      if (georefPickIndex === 0) {
        georefPickIndex = 1;
      } else {
        mode = 'idle';
        georefPickIndex = 0;
        step = 'georef';
      }
      persistSession();
      break;
  }
  renderCadScene();
  notify();
}

export function deleteExtractedPoint(id: number): void {
  extractedPoints = extractedPoints.filter(p => p.id !== id);
  renderCadScene();
  persistSession();
  notify();
}

export function deleteDimension(id: number): void {
  dimensions = dimensions.filter(d => d.id !== id);
  renderCadScene();
  persistSession();
  notify();
}

export function startGeorefPick(index: 0 | 1): void {
  step = 'cad';
  mode = 'georef-pick';
  georefPickIndex = index;
  notify();
}

// ── Coordinate-entry widget (DD / UTM / DLTM) — owned entirely by this file ────

export function getRefFmt(index: 0 | 1): CoordFmt { return refFmt[index]; }

export function setRefFmt(index: 0 | 1, fmt: CoordFmt): void {
  refFmt[index] = fmt;
  notify();
}

function inp(id: string): HTMLInputElement { return document.getElementById(id) as HTMLInputElement; }
function sel(id: string): HTMLSelectElement { return document.getElementById(id) as HTMLSelectElement; }

function readRefTarget(index: 0 | 1): { lat: number; lng: number; label: string; preferDltm: boolean } | null {
  const n = index + 1;
  const fmt = refFmt[index];
  if (fmt === 'dd') {
    const lat = parseFloat(inp(`dxfRef${n}Lat`).value);
    const lng = parseFloat(inp(`dxfRef${n}Lng`).value);
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng, label: 'Lat/Lng', preferDltm: false };
  }
  if (fmt === 'utm') {
    const e = parseFloat(inp(`dxfRef${n}UtmE`).value);
    const nor = parseFloat(inp(`dxfRef${n}UtmN`).value);
    const zone = parseInt(inp(`dxfRef${n}UtmZone`).value, 10);
    const south = sel(`dxfRef${n}UtmHemi`).value === 'S';
    if (isNaN(e) || isNaN(nor) || isNaN(zone) || zone < 1 || zone > 60) return null;
    const ll = utmToDecimal(e, nor, zone, south);
    if (!ll) return null;
    return { lat: ll[0], lng: ll[1], label: `UTM ${zone}${south ? 'S' : 'N'}`, preferDltm: false };
  }
  const e = parseFloat(inp(`dxfRef${n}DltmE`).value);
  const nor = parseFloat(inp(`dxfRef${n}DltmN`).value);
  if (isNaN(e) || isNaN(nor)) return null;
  const ll = dltmToDecimal(e, nor);
  if (!ll) return null;
  return { lat: ll[0], lng: ll[1], label: 'DLTM', preferDltm: true };
}

// ── Georeferencing (2-point Helmert transform) ──────────────────────────────────
// See the design plan for the derivation; this is the DXF-specific rigid-body
// fit between the drawing's local frame and a real-world metric frame, so it
// lives here rather than in mapView.ts/locationMap.ts (those only convert
// coordinates, they don't fit one coordinate frame onto another).

/** Same formula locationMap.ts's decimalToUtm uses, parametrized with an
 *  explicit zone/hemisphere so both reference points can be forced into the
 *  same UTM zone (locationMap.ts's version always auto-picks the zone from
 *  longitude, which the two ref points might disagree on near a zone edge). */
function decimalToUtmZone(lat: number, lng: number, zone: number, south: boolean): { easting: number; northing: number } | null {
  try {
    const def = `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
    const [easting, northing] = proj4('WGS84', def, [lng, lat]) as [number, number];
    if (!isFinite(easting) || !isFinite(northing)) return null;
    return { easting, northing };
  } catch { return null; }
}

function computeTransformFromResolvedRefs(): { ok: true } | { ok: false; error: string } {
  const [r1, r2] = refs;
  if (!r1.drawing || !r2.drawing) {
    return { ok: false, error: 'Both reference points need a drawing pick.' };
  }

  // ── Local CRS path (no geographic projection) ─────────────────────────────
  if (r1.targetLocal && r2.targetLocal) {
    const m1 = r1.targetLocal;
    const m2 = r2.targetLocal;
    const dxD = r2.drawing.x - r1.drawing.x, dyD = r2.drawing.y - r1.drawing.y;
    const dxT = m2.E - m1.E, dyT = m2.N - m1.N;
    const chordD = Math.hypot(dxD, dyD);
    const chordT = Math.hypot(dxT, dyT);
    if (chordD < 1e-6) return { ok: false, error: 'The two reference points are too close together on the drawing.' };
    if (chordT < 1e-6) return { ok: false, error: 'The two local target coordinates are identical — use two distinct points.' };
    const scale = chordT / chordD;
    const thetaRad = Math.atan2(dyT, dxT) - Math.atan2(dyD, dxD);
    transform = { scale, thetaRad, originDrawing: r1.drawing, originTarget: m1, crs: { kind: 'local' } };
    return { ok: true };
  }

  // ── Geographic CRS path ───────────────────────────────────────────────────
  if (!r1.targetLatLng || !r2.targetLatLng) {
    return { ok: false, error: 'Both reference points need a drawing pick and a real-world coordinate.' };
  }

  const useDltm = r1.preferDltm || r2.preferDltm;
  let m1: { E: number; N: number };
  let m2: { E: number; N: number };
  let crs: GeoTransform['crs'];

  if (useDltm) {
    const a = decimalToDltm(r1.targetLatLng.lat, r1.targetLatLng.lng);
    const b = decimalToDltm(r2.targetLatLng.lat, r2.targetLatLng.lng);
    if (!a || !b) return { ok: false, error: 'Could not project the reference points into DLTM.' };
    m1 = { E: a.easting, N: a.northing };
    m2 = { E: b.easting, N: b.northing };
    crs = { kind: 'dltm' };
  } else {
    const auto = decimalToUtm(r1.targetLatLng.lat, r1.targetLatLng.lng);
    if (!auto) return { ok: false, error: 'Could not project the reference points into UTM.' };
    const b = decimalToUtmZone(r2.targetLatLng.lat, r2.targetLatLng.lng, auto.zone, auto.south);
    if (!b) return { ok: false, error: 'Could not project the reference points into UTM.' };
    m1 = { E: auto.easting, N: auto.northing };
    m2 = { E: b.easting, N: b.northing };
    crs = { kind: 'utm', zone: auto.zone, south: auto.south };
  }

  const dxD = r2.drawing.x - r1.drawing.x, dyD = r2.drawing.y - r1.drawing.y;
  const dxT = m2.E - m1.E, dyT = m2.N - m1.N;
  const chordD = Math.hypot(dxD, dyD);
  const chordT = Math.hypot(dxT, dyT);
  if (chordD < 1e-6) return { ok: false, error: 'The two reference points are too close together on the drawing.' };
  if (chordT < 1e-6) return { ok: false, error: 'The two real-world target coordinates are identical — pick two distinct points.' };

  const scale = chordT / chordD;
  const thetaRad = Math.atan2(dyT, dxT) - Math.atan2(dyD, dxD);
  transform = { scale, thetaRad, originDrawing: r1.drawing, originTarget: m1, crs };
  return { ok: true };
}

function applyTransform(t: GeoTransform, x: number, y: number): { E: number; N: number } {
  const dx = x - t.originDrawing.x, dy = y - t.originDrawing.y;
  const cosT = Math.cos(t.thetaRad), sinT = Math.sin(t.thetaRad);
  return {
    E: t.originTarget.E + t.scale * (dx * cosT - dy * sinT),
    N: t.originTarget.N + t.scale * (dx * sinT + dy * cosT),
  };
}

function transformToLatLng(t: GeoTransform, x: number, y: number): [number, number] | null {
  if (t.crs.kind === 'local') return null;
  const { E, N } = applyTransform(t, x, y);
  return t.crs.kind === 'dltm' ? dltmToDecimal(E, N) : utmToDecimal(E, N, t.crs.zone, t.crs.south);
}

export function computeGeoreference(): { ok: true } | { ok: false; error: string } {
  const fmt0 = refFmt[0];
  const fmt1 = refFmt[1];

  if (fmt0 === 'local' || fmt1 === 'local') {
    if (fmt0 !== 'local' || fmt1 !== 'local') {
      return { ok: false, error: 'Both reference points must use the same format — either both Local or both geographic.' };
    }
    const e0 = parseFloat(inp('dxfRef1LocalE').value);
    const n0 = parseFloat(inp('dxfRef1LocalN').value);
    const e1 = parseFloat(inp('dxfRef2LocalE').value);
    const n1 = parseFloat(inp('dxfRef2LocalN').value);
    if (isNaN(e0) || isNaN(n0) || isNaN(e1) || isNaN(n1)) {
      return { ok: false, error: 'Enter valid local coordinates for both reference points.' };
    }
    refs[0] = { ...refs[0], targetLatLng: null, targetLocal: { E: e0, N: n0 }, targetLabel: 'Local', preferDltm: false };
    refs[1] = { ...refs[1], targetLatLng: null, targetLocal: { E: e1, N: n1 }, targetLabel: 'Local', preferDltm: false };
  } else {
    const t1 = readRefTarget(0);
    const t2 = readRefTarget(1);
    if (!t1 || !t2) return { ok: false, error: 'Enter valid real-world coordinates for both reference points.' };
    refs[0] = { ...refs[0], targetLatLng: { lat: t1.lat, lng: t1.lng }, targetLocal: null, targetLabel: t1.label, preferDltm: t1.preferDltm };
    refs[1] = { ...refs[1], targetLatLng: { lat: t2.lat, lng: t2.lng }, targetLocal: null, targetLabel: t2.label, preferDltm: t2.preferDltm };
  }

  const result = computeTransformFromResolvedRefs();
  if (!result.ok) return result;
  step = 'map';
  persistSession();
  notify();
  return { ok: true };
}

// ── Map verification step (reuses MapBlock) ─────────────────────────────────────

export function initMapStep(containerEl: HTMLElement): void {
  if (transform?.crs.kind !== 'local') {
    if (!mapBlock) {
      mapBlock = new MapBlock({ container: containerEl, baseLayers: ['satellite', 'street'], zoom: 17 });
    } else {
      mapBlock.invalidateSize();
    }
  }
  renderMapOverlay();
}

/** Projects the whole segment list in one pass with a cached proj4 converter
 *  (fresh per-call def-string parsing via utmToDecimal/dltmToDecimal would be
 *  wasteful for a drawing with thousands of segments). */
function projectSegments(segments: DxfSegment[], t: GeoTransform): Array<[L.LatLngTuple, L.LatLngTuple]> {
  const def = t.crs.kind === 'utm'
    ? `+proj=utm +zone=${t.crs.zone}${t.crs.south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`
    : DLTM_DEF;
  const converter = proj4(def, 'WGS84');
  const out: Array<[L.LatLngTuple, L.LatLngTuple]> = [];
  for (const seg of segments) {
    const m1 = applyTransform(t, seg.x1, seg.y1);
    const m2 = applyTransform(t, seg.x2, seg.y2);
    const [lng1, lat1] = converter.forward([m1.E, m1.N]) as [number, number];
    const [lng2, lat2] = converter.forward([m2.E, m2.N]) as [number, number];
    if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) continue;
    out.push([[lat1, lng1], [lat2, lng2]]);
  }
  return out;
}

function renderMapOverlay(): void {
  if (!transform || !parseResult) return;

  // ── Local CRS: compute coordinates for export but skip map display ─────────
  if (transform.crs.kind === 'local') {
    for (const p of extractedPoints) {
      const m = applyTransform(transform, p.x, p.y);
      p.realEasting = m.E;
      p.realNorthing = m.N;
      p.lat = undefined;
      p.lng = undefined;
    }
    el('dxfMapLocalNotice').hidden = false;
    el('dxfMapContainer').hidden = true;
    persistSession();
    return;
  }

  el('dxfMapLocalNotice').hidden = true;
  el('dxfMapContainer').hidden = false;

  if (!mapBlock) return;
  if (overlayGroup) { overlayGroup.remove(); overlayGroup = null; }

  const renderer = L.canvas({ padding: 0.5 });
  const group = L.layerGroup();
  for (const [a, b] of projectSegments(parseResult.segments, transform)) {
    L.polyline([a, b], { color: '#2563eb', weight: 1.5, renderer }).addTo(group);
  }
  group.addTo(mapBlock.getMap());
  overlayGroup = group;

  const markers = refs.flatMap((r, i) => {
    if (!r.drawing || !r.targetLatLng) return [];
    const projected = transformToLatLng(transform!, r.drawing.x, r.drawing.y);
    const projectedLine = projected
      ? `<br>Drawing → transform: ${projected[0].toFixed(6)}, ${projected[1].toFixed(6)}`
      : '';
    return [{
      id: `ref${i}`,
      lat: r.targetLatLng.lat, lng: r.targetLatLng.lng,
      label: `Ref ${i + 1}`,
      status: 'user' as const,
      popupHtml: `<b>Reference point ${i + 1}</b><br>Entered: ${r.targetLatLng.lat.toFixed(6)}, ${r.targetLatLng.lng.toFixed(6)} (${r.targetLabel})${projectedLine}`,
    }];
  });
  mapBlock.setMarkers(markers, { fit: true });

  for (const p of extractedPoints) {
    const ll = transformToLatLng(transform, p.x, p.y);
    const m = applyTransform(transform, p.x, p.y);
    p.realEasting = m.E;
    p.realNorthing = m.N;
    if (ll) { p.lat = ll[0]; p.lng = ll[1]; }
  }
  persistSession();
}

export function backToGeoref(): void {
  step = 'georef';
  notify();
}

export function backToCad(): void {
  step = 'cad';
  notify();
}

// ════════════════════════════════════════════════════════════════════════════
//  DOM wiring — owns the entire view. main.ts only toggles #dxfToolView's own
//  outer visibility and calls mount()/open()/close(); every button, drop
//  zone, format tab and list in this tool's four steps is wired here.
// ════════════════════════════════════════════════════════════════════════════

let mounted = false;
let lastShownStep: DxfStep | null = null;

function el<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }

function escHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function showStep(next: DxfStep): void {
  el('dxfUploadSection').hidden = next !== 'upload';
  el('dxfCadSection').hidden = next !== 'cad';
  el('dxfGeorefSection').hidden = next !== 'georef';
  el('dxfMapSection').hidden = next !== 'map';

  if (next === 'cad') {
    requestAnimationFrame(() => {
      initCadCanvas(el<HTMLCanvasElement>('dxfCanvasEl'));
      invalidateCadCanvas();
      renderCadScene();
    });
  } else if (next === 'georef') {
    renderGeorefForm();
  } else if (next === 'map') {
    requestAnimationFrame(() => initMapStep(el('dxfMapContainer')));
  }
}

function updateToolbarState(): void {
  el('dxfMeasureBtn').classList.toggle('active', mode === 'measure');
  el('dxfExtractBtn').classList.toggle('active', mode === 'extract');
  el('dxfSetRefBtn').classList.toggle('active', mode === 'georef-pick');
  el<HTMLSelectElement>('dxfSnapModeSelect').value = snapMode;
  el('dxfUnitsBanner').hidden = !getUnitsUnknown();
}

function updateHint(): void {
  const hintEl = el('dxfCadHint');
  if (mode === 'measure') {
    hintEl.textContent = pendingMeasureP1 ? 'Click the second point to finish measuring' : 'Click the first point to measure';
  } else if (mode === 'extract') {
    hintEl.textContent = 'Click a point to extract its coordinate (snaps to endpoints/intersections)';
  } else if (mode === 'georef-pick') {
    hintEl.textContent = georefPickIndex === 0
      ? 'Click the FIRST reference point on the drawing'
      : 'Click the SECOND reference point on the drawing';
  } else {
    hintEl.textContent = 'Drag to pan, scroll to zoom — pick a tool below to measure or extract points';
  }
}

function updateLists(): void {
  const panel = el('dxfCadListPanel');
  const parts: string[] = [];
  if (extractedPoints.length === 0 && dimensions.length === 0) {
    parts.push('<p class="loc-empty">No extracted points or measurements yet.</p>');
  }
  if (extractedPoints.length > 0) {
    parts.push(`<div class="loc-list-header">Extracted points (${extractedPoints.length})</div>`);
    for (const p of extractedPoints) {
      parts.push(
        `<div class="ps-list-item">
          <div>
            <div class="ps-list-item-pt">${escHtml(p.label)}</div>
            <div class="ps-action-coords">x=${p.x.toFixed(3)} y=${p.y.toFixed(3)} (${p.snapKind})</div>
          </div>
          <button class="btn-del" data-del-extract="${p.id}" aria-label="Delete">✕</button>
        </div>`,
      );
    }
  }
  if (dimensions.length > 0) {
    parts.push(`<div class="loc-list-header">Measurements (${dimensions.length})</div>`);
    for (const d of dimensions) {
      parts.push(
        `<div class="ps-list-item">
          <div>
            <div class="ps-list-item-pt">${d.distance.toFixed(3)} m</div>
            <div class="ps-action-coords">bearing ${d.bearingDeg.toFixed(1)}°</div>
          </div>
          <button class="btn-del" data-del-dim="${d.id}" aria-label="Delete">✕</button>
        </div>`,
      );
    }
  }
  panel.innerHTML = parts.join('');
}

function renderGeorefForm(): void {
  for (const idx of [0, 1] as const) {
    const n = idx + 1;
    const r = refs[idx];
    el(`dxfRef${n}DrawingStatus`).textContent = r.drawing
      ? `Picked: x=${r.drawing.x.toFixed(3)}, y=${r.drawing.y.toFixed(3)}`
      : 'Not picked yet';
    const fmt = refFmt[idx];
    el(`dxfRef${n}PanelDD`).hidden = fmt !== 'dd';
    el(`dxfRef${n}PanelUTM`).hidden = fmt !== 'utm';
    el(`dxfRef${n}PanelDLTM`).hidden = fmt !== 'dltm';
    el(`dxfRef${n}PanelLocal`).hidden = fmt !== 'local';
    document.querySelectorAll<HTMLButtonElement>(`#dxfRef${n}FmtTabs .loc-fmt-tab`).forEach(tab => {
      tab.classList.toggle('active', tab.dataset.fmt === fmt);
    });
  }
}

function renderUI(): void {
  if (step !== lastShownStep) {
    lastShownStep = step;
    showStep(step);
  }
  updateToolbarState();
  updateHint();
  updateLists();
  if (step === 'georef') renderGeorefForm();
}

async function handleUpload(file: File): Promise<void> {
  el('dxfErrorBanner').hidden = true;
  el('dxfFileName').textContent = file.name;
  el('dxfFileBadge').hidden = false;
  const result = await handleFile(file);
  if (!result.ok) {
    el('dxfErrorText').textContent = result.error;
    el('dxfErrorBanner').hidden = false;
    return;
  }
  notify();
}

export function mount(): void {
  if (mounted) return;
  mounted = true;

  onDxfChange(renderUI);

  // ── Upload step ──
  el('dxfResumeBtn').addEventListener('click', () => {
    if (restorePersistedSession()) { lastShownStep = null; notify(); }
  });
  el('dxfDiscardBtn').addEventListener('click', () => {
    clearPersistedSession();
    el('dxfResumeCard').hidden = true;
    el('dxfUploadZone').hidden = false;
  });

  const dropZone = el<HTMLLabelElement>('dxfDropZone');
  const fileInput = el<HTMLInputElement>('dxfFileInput');
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleUpload(file);
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void handleUpload(file);
  });
  el('dxfClearBtn').addEventListener('click', () => {
    fileInput.value = '';
    el('dxfFileBadge').hidden = true;
  });

  // ── CAD step ──
  el('dxfZoomExtentsBtn').addEventListener('click', () => zoomExtents());
  el('dxfZoomInBtn').addEventListener('click', () => zoomIn());
  el('dxfZoomOutBtn').addEventListener('click', () => zoomOut());
  el('dxfSnapModeSelect').addEventListener('change', e => {
    setSnapMode((e.target as HTMLSelectElement).value as SnapMode);
  });
  el('dxfMeasureBtn').addEventListener('click', () => setInteractionMode(mode === 'measure' ? 'idle' : 'measure'));
  el('dxfExtractBtn').addEventListener('click', () => setInteractionMode(mode === 'extract' ? 'idle' : 'extract'));
  el('dxfSetRefBtn').addEventListener('click', () => startGeorefPick(0));
  el('dxfGotoGeorefBtn').addEventListener('click', () => { step = 'georef'; notify(); });
  el('dxfCadListBtn').addEventListener('click', () => {
    const panel = el('dxfCadListPanel');
    panel.hidden = !panel.hidden;
  });
  el('dxfUnitsButtons').addEventListener('click', e => {
    const btn = (e.target as Element).closest<HTMLButtonElement>('[data-unit]');
    if (btn?.dataset.unit) confirmUnits(btn.dataset.unit as Exclude<DxfUnits, 'unknown'>);
  });
  el('dxfCadListPanel').addEventListener('click', e => {
    const delExtract = (e.target as Element).closest<HTMLElement>('[data-del-extract]');
    if (delExtract) { deleteExtractedPoint(Number(delExtract.dataset.delExtract)); return; }
    const delDim = (e.target as Element).closest<HTMLElement>('[data-del-dim]');
    if (delDim) deleteDimension(Number(delDim.dataset.delDim));
  });

  // ── Georeference step ──
  el('dxfGeorefBackBtn').addEventListener('click', () => backToCad());
  for (const idx of [0, 1] as const) {
    const n = idx + 1;
    el(`dxfRef${n}PickBtn`).addEventListener('click', () => startGeorefPick(idx));
    el(`dxfRef${n}FmtTabs`).addEventListener('click', e => {
      const tab = (e.target as Element).closest<HTMLButtonElement>('.loc-fmt-tab');
      if (tab?.dataset.fmt) setRefFmt(idx, tab.dataset.fmt as CoordFmt);
    });
  }
  el('dxfComputeBtn').addEventListener('click', () => {
    const result = computeGeoreference();
    el('dxfGeorefError').hidden = result.ok;
    if (!result.ok) el('dxfGeorefError').textContent = result.error;
  });

  // ── Map step ──
  el('dxfMapBackBtn').addEventListener('click', () => backToGeoref());
  el('dxfExportCsvBtn').addEventListener('click', () => exportDxfPointsCsv(extractedPoints, sourceFileName || 'drawing'));
  el('dxfExportJsonBtn').addEventListener('click', () => exportDxfPointsJson(extractedPoints, sourceFileName || 'drawing'));
  el('dxfMapFullscreenBtn').addEventListener('click', () => {
    const section = el('dxfMapSection');
    if (!document.fullscreenElement) {
      void section.requestFullscreen();
    } else {
      void document.exitFullscreen();
    }
  });
  el('dxfMapSection').addEventListener('fullscreenchange', () => {
    const isFs = !!document.fullscreenElement;
    const btn = el('dxfMapFullscreenBtn');
    btn.textContent = isFs ? '⊡' : '⛶';
    btn.title = isFs ? 'Exit fullscreen' : 'Fullscreen map';
    mapBlock?.invalidateSize();
  });
}

export function open(): void {
  const summary = getPersistedSummary();
  if (summary) {
    el('dxfResumeDetail').textContent =
      `${summary.fileName || 'Untitled'} — ${summary.extracted} extracted, ${summary.dimensions} measurements`;
    el('dxfResumeCard').hidden = false;
    el('dxfUploadZone').hidden = true;
  } else {
    el('dxfResumeCard').hidden = true;
    el('dxfUploadZone').hidden = false;
  }
  step = 'upload';
  lastShownStep = null;
  renderUI();
}

export function close(): void {
  resetSession();
}
