import html2canvas from 'html2canvas';
import type { SurveyPoint, SignPoint, SignStatus } from './types';
import { convertSurveyPoints } from './mapView';
import { MapBlock, type MarkerStatus } from './mapBlock';

// ── Session state ──────────────────────────────────────────────────────────

let points: SignPoint[] = [];
let selectedId: number | null = null;
let zoneLabel = '';
let sourceFileName = '';

let _onChange: (() => void) | null = null;
export function onSignChange(cb: () => void): void { _onChange = cb; }
function notify(): void { _onChange?.(); }

// ── Session persistence ──────────────────────────────────────────────────────
// A field session can span hours outdoors, where a dropped tab, a phone call,
// or a low-battery restart is routine. Everything needed to resume — the
// converted points, their sign-off status, and the selection — is mirrored to
// localStorage on every meaningful change (not on GPS/compass ticks, which
// fire every couple of seconds and would just churn writes for no benefit).

const SESSION_KEY = 'survey-point-signing-session-v1';

interface PersistedSession {
  points: SignPoint[];
  selectedId: number | null;
  zoneLabel: string;
  sourceFileName: string;
}

function persistSession(): void {
  try {
    if (points.length === 0) { localStorage.removeItem(SESSION_KEY); return; }
    const payload: PersistedSession = { points, selectedId, zoneLabel, sourceFileName };
    localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  } catch { /* storage full or unavailable — session just won't survive a reload */ }
}

export function hasPersistedSession(): boolean {
  try { return localStorage.getItem(SESSION_KEY) !== null; } catch { return false; }
}

/** Summary for a resume prompt, without mutating the live session. */
export function getPersistedSummary(): { fileName: string; zoneLabel: string; signed: number; total: number } | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PersistedSession;
    if (!Array.isArray(data.points) || data.points.length === 0) return null;
    const signed = data.points.filter(p => p.status !== 'pending').length;
    return { fileName: data.sourceFileName, zoneLabel: data.zoneLabel, signed, total: data.points.length };
  } catch { return null; }
}

export function restorePersistedSession(): boolean {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw) as PersistedSession;
    if (!Array.isArray(data.points) || data.points.length === 0) return false;
    points = data.points;
    selectedId = data.selectedId ?? null;
    zoneLabel = data.zoneLabel ?? '';
    sourceFileName = data.sourceFileName ?? '';
    return true;
  } catch { return false; }
}

export function clearPersistedSession(): void {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

export function loadSignPoints(
  raw: SurveyPoint[],
  zoneSel: string,
  fileName: string,
): { ok: true; label: string } | { ok: false; error: string } {
  const conv = convertSurveyPoints(raw, zoneSel);
  if (!conv) {
    return { ok: false, error: 'Coordinate system not recognized (expected UTM zones 30–42 or geographic lat/lon).' };
  }
  // Re-applying a zone to the same upload (e.g. changing the zone select
  // mid-session) must not wipe field progress — carry statuses over when the
  // point list is unchanged.
  const prev = points;
  const sameSession =
    fileName === sourceFileName &&
    prev.length === conv.points.length &&
    prev.every((p, i) => p.pointNumber === conv.points[i].pointNumber);
  points = conv.points.map((p, i) => ({
    id: i,
    pointNumber: p.pointNumber,
    easting: p.easting,
    northing: p.northing,
    elevation: p.elevation,
    lat: conv.latLons[i][0],
    lng: conv.latLons[i][1],
    status: sameSession ? prev[i].status : ('pending' as SignStatus),
    statusAt: sameSession ? prev[i].statusAt : null,
  }));
  selectedId = null;
  zoneLabel = conv.label;
  sourceFileName = fileName;
  persistSession();
  return { ok: true, label: conv.label };
}

// Leaves the persisted copy untouched — this only clears the in-memory view
// state (e.g. when the user backs out of the Points step to the home
// screen). The next time the tool opens, the caller checks
// hasPersistedSession() and offers to resume rather than losing the session.
export function resetSession(): void {
  points = [];
  selectedId = null;
  zoneLabel = '';
  sourceFileName = '';
}

export function getSignPoints(): SignPoint[] { return points; }
export function getZoneLabel(): string { return zoneLabel; }
export function getSourceFileName(): string { return sourceFileName; }

export function progressCounts(): { signed: number; obstructed: number; pending: number; total: number } {
  let signed = 0, obstructed = 0;
  for (const p of points) {
    if (p.status === 'signed') signed++;
    else if (p.status === 'obstructed') obstructed++;
  }
  return { signed, obstructed, pending: points.length - signed - obstructed, total: points.length };
}

// ── Map ──────────────────────────────────────────────────────────────────────
// The map, marker shapes and animations all live in the shared MapBlock; each
// point's `status` drives its colour via CSS. This module maps SignPoints onto
// markers and reacts to selection/sign-off.

let block: MapBlock | null = null;

export function initSignMap(): void {
  if (block) return;
  block = new MapBlock({ container: 'psMapContainer', center: [24.7, 46.7], zoom: 5 });
}

export function invalidateSignMapSize(): void { block?.invalidateSize(); }

export function renderSignMap(): void {
  if (!block) return;
  block.setMarkers(
    points.map(pt => ({
      id: pt.id,
      lat: pt.lat,
      lng: pt.lng,
      label: pt.pointNumber,
      status: pt.status as MarkerStatus,   // 'signed' | 'obstructed' | 'pending'
      selected: pt.id === selectedId,
      onClick: (id) => selectPoint(id as number),
    })),
    { fit: selectedId === null },
  );
}

export function fitAllPoints(): void {
  if (points.length === 0) return;
  block?.fitAll({ animate: true });
}

// ── Selection / navigation ───────────────────────────────────────────────────

export function selectPoint(id: number): void {
  selectedId = id;
  block?.selectMarker(id, { fly: true, flyZoom: 20 });
  notify();
}

export function deselect(): void {
  selectedId = null;
  renderSignMap();
  notify();
}

export function getSelectedPoint(): SignPoint | null {
  return points.find(p => p.id === selectedId) ?? null;
}

function nextPendingId(afterId: number | null): number | null {
  if (points.length === 0) return null;
  const startIdx = afterId === null ? -1 : points.findIndex(p => p.id === afterId);
  for (let offset = 1; offset <= points.length; offset++) {
    const idx = (startIdx + offset) % points.length;
    if (points[idx].status === 'pending') return points[idx].id;
  }
  return null;
}

function advanceFrom(fromId: number): void {
  const next = nextPendingId(fromId);
  if (next !== null) selectPoint(next);
  else deselect();
}

export function signSelected(): void {
  const pt = getSelectedPoint();
  if (!pt) return;
  pt.status = 'signed';
  pt.statusAt = new Date().toISOString();
  persistSession();
  advanceFrom(pt.id);
}

export function markObstructedSelected(): void {
  const pt = getSelectedPoint();
  if (!pt) return;
  pt.status = 'obstructed';
  pt.statusAt = new Date().toISOString();
  persistSession();
  advanceFrom(pt.id);
}

export function resetPointStatus(id: number): void {
  const pt = points.find(p => p.id === id);
  if (!pt) return;
  pt.status = 'pending';
  pt.statusAt = null;
  persistSession();
  renderSignMap();
  notify();
}

export function goToNextPending(): void {
  const next = nextPendingId(selectedId);
  if (next !== null) selectPoint(next);
}

// ── Live GPS + compass bearing ───────────────────────────────────────────────

export interface CompassState {
  geoSupported: boolean;
  orientationSupported: boolean;
  permissionNeeded: boolean;
  heading: number | null;     // device compass heading, degrees 0–360
  bearing: number | null;     // bearing from user to selected point, degrees 0–360
  distanceM: number | null;
}

let userPos: { lat: number; lng: number } | null = null;
let headingDeg: number | null = null;
let watchId: number | null = null;

interface CompassOrientationEvent {
  alpha: number | null;
  webkitCompassHeading?: number;
}

type DeviceOrientationEventCtor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

let orientationHandler: ((e: Event) => void) | null = null;
let orientationEventName: 'deviceorientationabsolute' | 'deviceorientation' = 'deviceorientation';

export function startLocationWatch(): void {
  if (!navigator.geolocation || watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(
    pos => { userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude }; notify(); },
    () => { /* GPS unavailable — compass widget degrades to heading-only */ },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 },
  );
}

export function stopLocationWatch(): void {
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  userPos = null;
}

export function needsOrientationPermission(): boolean {
  const ctor = DeviceOrientationEvent as DeviceOrientationEventCtor;
  return typeof ctor.requestPermission === 'function' && !orientationHandler;
}

export async function requestOrientationPermission(): Promise<boolean> {
  const ctor = DeviceOrientationEvent as DeviceOrientationEventCtor;
  if (typeof ctor.requestPermission !== 'function') {
    attachOrientation();
    return true;
  }
  try {
    const result = await ctor.requestPermission();
    if (result === 'granted') { attachOrientation(); return true; }
    return false;
  } catch {
    return false;
  }
}

export function attachOrientation(): void {
  if (orientationHandler) return;
  orientationEventName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
  orientationHandler = (e: Event) => {
    const evt = e as unknown as CompassOrientationEvent;
    const heading = typeof evt.webkitCompassHeading === 'number'
      ? evt.webkitCompassHeading
      : (evt.alpha !== null && evt.alpha !== undefined ? (360 - evt.alpha) % 360 : null);
    headingDeg = heading;
    notify();
  };
  window.addEventListener(orientationEventName, orientationHandler, true);
}

export function detachOrientation(): void {
  if (!orientationHandler) return;
  window.removeEventListener(orientationEventName, orientationHandler, true);
  orientationHandler = null;
  headingDeg = null;
}

function toRad(d: number): number { return d * Math.PI / 180; }

function bearingBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function distanceBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function getCompassState(): CompassState {
  const target = getSelectedPoint();
  const base = {
    geoSupported: !!navigator.geolocation,
    orientationSupported: typeof DeviceOrientationEvent !== 'undefined',
    permissionNeeded: needsOrientationPermission(),
    heading: headingDeg,
  };
  if (!target || !userPos) return { ...base, bearing: null, distanceM: null };
  return {
    ...base,
    bearing: bearingBetween(userPos.lat, userPos.lng, target.lat, target.lng),
    distanceM: distanceBetween(userPos.lat, userPos.lng, target.lat, target.lng),
  };
}

export function getUserPosition(): { lat: number; lng: number } | null { return userPos; }

// ── Report ────────────────────────────────────────────────────────────────────

export async function captureMapScreenshot(): Promise<string | null> {
  const el = document.getElementById('psMapContainer');
  if (!el) return null;
  try {
    const canvas = await html2canvas(el, { useCORS: true, logging: false });
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}
