import proj4 from 'proj4';
import { DLTM_DEF } from './mapView';
import { MapBlock } from './mapBlock';

export interface SavedLocation {
  id: string;
  name: string;
  desc?: string;
  lat: number;
  lng: number;
}

// ── Persistence ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'survey-locations-v2';
const API_BASE = '/api/locations';

// Optional shared token, injected at build time (VITE_API_TOKEN). Sent only
// when configured; the Worker stays open when no token is set on either side.
const API_TOKEN = import.meta.env.VITE_API_TOKEN as string | undefined;
function authHeaders(): Record<string, string> {
  return API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {};
}

let _locations: SavedLocation[] = ((): SavedLocation[] => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'); } catch { return []; }
})();

function persist(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_locations)); } catch {}
}

// Tombstones: ids deleted on this device. Without them, a delete whose cloud
// DELETE failed (e.g. offline) resurrects the point on the next cloud sync.
const TOMBSTONE_KEY = 'survey-locations-deleted-v1';

const _deletedIds: Set<string> = ((): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem(TOMBSTONE_KEY) ?? '[]') as string[]); }
  catch { return new Set(); }
})();

function persistTombstones(): void {
  try { localStorage.setItem(TOMBSTONE_KEY, JSON.stringify([..._deletedIds])); } catch {}
}

// ── Change notification ─────────────────────────────────────────────────────────
// A single subscription point so the UI re-renders on any data change (add,
// delete, or async cloud sync) instead of every call site having to remember.
let _onChange: (() => void) | null = null;

export function onLocationsChanged(cb: () => void): void {
  _onChange = cb;
}

function notifyChange(): void {
  persist();
  rebuildMarkers();
  _onChange?.();
}

async function syncToCloud(loc: SavedLocation): Promise<void> {
  try {
    await fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(loc),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    // Cloud sync is optional — localStorage is the authoritative source
    console.debug('Cloud sync unavailable (offline or API not configured)');
  }
}

async function deleteFromCloud(id: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authHeaders(),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    // Cloud delete is optional — localStorage is the authoritative source
    console.debug('Cloud delete unavailable (offline or API not configured)');
  }
}

let _cloudLoaded = false;

export async function loadFromCloud(): Promise<void> {
  if (_cloudLoaded) return;            // sync once per session, not on every page open
  try {
    const res = await fetch(API_BASE, { headers: authHeaders(), signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      _cloudLoaded = true;
      const cloudLocs = await res.json() as SavedLocation[];
      const localIds = new Set(_locations.map(l => l.id));
      let changed = false;
      for (const loc of cloudLocs) {
        if (_deletedIds.has(loc.id)) {
          // Deleted here but still in the cloud — the original DELETE most
          // likely failed offline. Retry it instead of resurrecting the point.
          deleteFromCloud(loc.id);
          continue;
        }
        if (!localIds.has(loc.id)) {
          _locations.push(loc);
          changed = true;
        }
      }
      // Prune tombstones for ids the cloud no longer has: the delete went
      // through, so the marker has done its job and can be dropped.
      const cloudIds = new Set(cloudLocs.map(l => l.id));
      const tombstonesBefore = _deletedIds.size;
      for (const id of [..._deletedIds]) {
        if (!cloudIds.has(id)) _deletedIds.delete(id);
      }
      if (_deletedIds.size !== tombstonesBefore) persistTombstones();
      if (changed) notifyChange();      // refresh map markers *and* the saved-points list
      console.debug('[Cloud] Synced', cloudLocs.length, 'locations from cloud');
    }
  } catch (err) {
    // Cloud API is optional — app works fine with local storage only.
    // Leave _cloudLoaded false so a later open can retry once back online.
    console.debug('Cloud load unavailable (offline or API not configured):', err instanceof Error ? err.message : err);
  }
}

export function getLocations(): SavedLocation[] {
  return _locations;
}

export function addLocation(name: string, lat: number, lng: number, desc?: string): void {
  const loc: SavedLocation = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name: name.trim(),
    desc: desc?.trim() || undefined,
    lat,
    lng,
  };
  _locations.push(loc);
  syncToCloud(loc);
  notifyChange();
  block?.flyTo(lat, lng, 14);
}

export function deleteLocation(id: string): void {
  _locations = _locations.filter(l => l.id !== id);
  _deletedIds.add(id);
  persistTombstones();
  deleteFromCloud(id);
  notifyChange();
  if (_locations.length > 0) fitToSavedPoints();
  else block?.setView(24.7, 46.7, 5);
}

// ── Map lifecycle ─────────────────────────────────────────────────────────────
// Rendering is delegated to the shared MapBlock. This module owns only the
// saved-location domain: what each marker's popup says and how the camera
// reacts to add/delete/pick.

let block: MapBlock | null = null;
let pickCallback: ((lat: number, lng: number) => void) | null = null;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function popupHtml(loc: SavedLocation): string {
  const descHtml = loc.desc ? `<div class="loc-popup-desc">${esc(loc.desc)}</div>` : '';
  return `<b>${esc(loc.name)}</b>${descHtml}
    <div class="loc-popup-coords">Lat: ${loc.lat.toFixed(6)}<br>Lng: ${loc.lng.toFixed(6)}</div>`;
}

export function initLocationMap(): void {
  if (block) { block.invalidateSize(); return; }
  block = new MapBlock({
    container: 'locMapContainer',
    center: [24.7, 46.7],
    zoom: 5,
    onMapClick: (lat, lng) => {
      if (!pickCallback) return;
      pickCallback(lat, lng);
      setPickMode(false);
    },
  });
  rebuildMarkers();
  if (_locations.length > 0) fitToSavedPoints();
}

export function invalidateLocMapSize(): void {
  block?.invalidateSize();
}

export function setPickMode(on: boolean, cb?: (lat: number, lng: number) => void): void {
  pickCallback = on && cb ? cb : null;
  block?.setPickMode(on);
}

export function showUserOnMap(lat: number, lng: number): void {
  block?.setUserMarker(lat, lng);
}

function rebuildMarkers(): void {
  block?.setMarkers(_locations.map(loc => ({
    id: loc.id,
    lat: loc.lat,
    lng: loc.lng,
    label: loc.name,
    popupHtml: popupHtml(loc),
    actions: [{
      label: '🗺 Navigate to location',
      className: 'mb-btn--nav',
      onClick: () => window.open(
        `https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}`,
        '_blank', 'noopener,noreferrer',
      ),
    }],
  })));
}

function fitToSavedPoints(): void {
  if (_locations.length === 0) return;
  block?.fitAll();
}

// ── Coordinate conversions ────────────────────────────────────────────────────
// DLTM_DEF is imported from mapView.ts — one definition for the whole app.

export function dltmToDecimal(easting: number, northing: number): [number, number] | null {
  try {
    const [lng, lat] = proj4(DLTM_DEF, 'WGS84', [easting, northing]) as [number, number];
    if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return [lat, lng];
  } catch { return null; }
}

export function decimalToDltm(lat: number, lng: number): { easting: number; northing: number } | null {
  try {
    const [easting, northing] = proj4('WGS84', DLTM_DEF, [lng, lat]) as [number, number];
    if (!isFinite(easting) || !isFinite(northing)) return null;
    return { easting, northing };
  } catch { return null; }
}

export function utmToDecimal(easting: number, northing: number, zone: number, south: boolean): [number, number] | null {
  try {
    const def = `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
    const [lng, lat] = proj4(def, 'WGS84', [easting, northing]) as [number, number];
    if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return [lat, lng];
  } catch { return null; }
}

export function decimalToUtm(lat: number, lng: number): { easting: number; northing: number; zone: number; south: boolean } | null {
  try {
    const zone = Math.floor((lng + 180) / 6) + 1;
    const south = lat < 0;
    const def = `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
    const [easting, northing] = proj4('WGS84', def, [lng, lat]) as [number, number];
    if (!isFinite(easting) || !isFinite(northing)) return null;
    return { easting, northing, zone, south };
  } catch { return null; }
}
