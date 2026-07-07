import L from 'leaflet';
import proj4 from 'proj4';
import type { SurveyPoint } from './types';
import { MapBlock } from './mapBlock';

type LatLon = [number, number]; // [lat, lng]

let block: MapBlock | null = null;

// ── Coordinate detection ──────────────────────────────────────────────────────

function isGeographic(e: number, n: number): boolean {
  return Math.abs(e) <= 180 && Math.abs(n) <= 90;
}

function isUtmRange(e: number, n: number): boolean {
  return e > 100_000 && e < 900_000 && n >= 0 && n < 10_200_000;
}

/** Upper bound of a valid UTM / TM Easting (false-easting 500 000, zone ≤ 6° wide). */
const UTM_EASTING_MAX = 900_000;

/**
 * Recognise which column is the Northing and which is the Easting for a set of
 * projected survey points, and return them in canonical { easting, northing }
 * orientation.
 *
 * Survey PDFs are inconsistent about column order — some list Easting first,
 * others Northing first. For the projected grids this tool plots (UTM zones
 * 30–42 and the DLTM grid) the two are easy to tell apart by magnitude:
 *
 *   • An Easting is bounded to ~100 000–900 000 m → never more than 6 digits.
 *   • A Northing in the northern hemisphere is routinely ≥ 1 000 000 m (7 digits);
 *     the Gulf region this app targets sits near 2 700 000 m.
 *
 * So when the value sitting in the Easting slot is too large to be an Easting
 * while the Northing slot holds a valid Easting, the columns were read in the
 * wrong order. The decision is made per dataset (majority vote over the points
 * that are unambiguous) so the whole table stays consistent; geographic or
 * small/local-grid data, where the test is inconclusive, is returned unchanged.
 */
export function orientNorthingEasting<T extends { easting: number; northing: number }>(points: T[]): T[] {
  let decisive = 0;
  let swapVotes = 0;
  for (const p of points) {
    const eOutOfRange = Math.abs(p.easting) > UTM_EASTING_MAX;
    const nOutOfRange = Math.abs(p.northing) > UTM_EASTING_MAX;
    if (eOutOfRange === nOutOfRange) continue;   // both in or both out → not decisive
    decisive++;
    if (eOutOfRange) swapVotes++;                // Easting slot holds the bigger value
  }
  if (decisive > 0 && swapVotes * 2 > decisive) {
    return points.map(p => ({ ...p, easting: p.northing, northing: p.easting }));
  }
  return points;
}

function utmToLatLon(e: number, n: number, zone: number, south: boolean): LatLon | null {
  try {
    const def = `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
    const [lng, lat] = proj4(def, 'WGS84', [e, n]) as [number, number];
    if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return [lat, lng];
  } catch {
    return null;
  }
}

// Dubai Local Transverse Mercator (EPSG:3997) — the single shared definition;
// the Location Map tool imports it from here. Its central meridian (55.333°)
// differs from the UTM zone 39/40 meridians, so points in this grid fail
// every standard UTM zone and need their own def.
export const DLTM_DEF = '+proj=tmerc +lat_0=0 +lon_0=55.3333333333333 +k=1 +x_0=500000 +y_0=0 +datum=WGS84 +units=m +no_defs';

function dltmToLatLon(e: number, n: number): LatLon | null {
  try {
    const [lng, lat] = proj4(DLTM_DEF, 'WGS84', [e, n]) as [number, number];
    if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return [lat, lng];
  } catch {
    return null;
  }
}

interface ConversionResult {
  latLons: LatLon[];
  label: string;
}

type ZoneSelection = { zone: number; south: boolean } | 'dltm';

function convertPoints(points: SurveyPoint[], forcedZone?: ZoneSelection): ConversionResult | null {
  if (points.length === 0) return null;
  const { easting: e0, northing: n0 } = points[0];

  // Geographic lat/lon — E maps to longitude, N to latitude
  if (isGeographic(e0, n0) && points.every(p => isGeographic(p.easting, p.northing))) {
    return {
      latLons: points.map(p => [p.northing, p.easting] as LatLon),
      label: 'Geographic (Lat/Lon)',
    };
  }

  if (!isUtmRange(e0, n0)) return null;

  // Use forced zone if provided
  if (forcedZone === 'dltm') {
    const converted: LatLon[] = [];
    for (const p of points) {
      const ll = dltmToLatLon(p.easting, p.northing);
      if (!ll) return null;
      converted.push(ll);
    }
    return { latLons: converted, label: 'DLTM' };
  }

  if (forcedZone) {
    const { zone, south } = forcedZone;
    const converted: LatLon[] = [];
    for (const p of points) {
      const ll = utmToLatLon(p.easting, p.northing, zone, south);
      if (!ll) return null;
      converted.push(ll);
    }
    return { latLons: converted, label: `UTM Zone ${zone}${south ? 'S' : 'N'}` };
  }

  // Auto-detect: try DLTM first (distinct central meridian from any UTM zone),
  // then fall back to scanning UTM zones 30–42 for each hemisphere.
  {
    const converted: LatLon[] = [];
    let ok = true;
    for (const p of points) {
      const ll = dltmToLatLon(p.easting, p.northing);
      if (!ll) { ok = false; break; }
      converted.push(ll);
    }
    if (ok) {
      const lats = converted.map(c => c[0]);
      const lngs = converted.map(c => c[1]);
      const span = (Math.max(...lats) - Math.min(...lats)) + (Math.max(...lngs) - Math.min(...lngs));
      if (span < 10) return { latLons: converted, label: 'DLTM' };
    }
  }

  for (const south of [false, true]) {
    for (let zone = 30; zone <= 42; zone++) {
      const converted: LatLon[] = [];
      let ok = true;
      for (const p of points) {
        const ll = utmToLatLon(p.easting, p.northing, zone, south);
        if (!ll) { ok = false; break; }
        converted.push(ll);
      }
      if (!ok) continue;

      const lats = converted.map(c => c[0]);
      const lngs = converted.map(c => c[1]);
      const span = (Math.max(...lats) - Math.min(...lats)) + (Math.max(...lngs) - Math.min(...lngs));

      if (span < 10) {
        return { latLons: converted, label: `UTM Zone ${zone}${south ? 'S' : 'N'}` };
      }
    }
  }
  return null;
}

// ── Reusable projection (for tools other than the map view itself) ────────────

export interface SurveyConversion {
  /** Points re-ordered into canonical { easting, northing } (see orientNorthingEasting). */
  points: SurveyPoint[];
  latLons: LatLon[];
  label: string;
}

/**
 * Auto-detects (or applies a forced) projection and converts survey points to
 * lat/lng, using the same zone-select values as the Survey Extractor's map
 * toolbar ('auto' | 'dltm' | '<zone><N|S>'). Shared so other tools (e.g. Point
 * Signing) don't duplicate the UTM/DLTM zone-scanning logic.
 */
export function convertSurveyPoints(points: SurveyPoint[], zoneSel: string): SurveyConversion | null {
  const oriented = orientNorthingEasting(points);

  let forcedZone: ZoneSelection | undefined;
  if (zoneSel === 'dltm') {
    forcedZone = 'dltm';
  } else if (zoneSel !== 'auto') {
    const zone = parseInt(zoneSel, 10);
    const south = zoneSel.endsWith('S');
    forcedZone = { zone, south };
  }

  const result = convertPoints(oriented, forcedZone);
  if (!result) return null;
  return { points: oriented, latLons: result.latLons, label: result.label };
}

// ── Map lifecycle ─────────────────────────────────────────────────────────────
// All rendering is delegated to the shared MapBlock; this module keeps only the
// Extractor-specific bits: reading the zone-select toolbar, projecting points,
// and writing the detected-zone badge.

export function initMap(): void {
  if (block) return;
  block = new MapBlock({
    container: 'mapContainer',
    center: [26, 30],
    zoom: 6,
    baseLayers: ['street', 'satellite', 'topo'],
    zoomLabels: true,
  });
}

export function renderMap(points: SurveyPoint[]): void {
  if (!block) return;
  block.clearMarkers();
  block.closePopup();

  const zoneEl = document.getElementById('mapZoneInfo');
  if (zoneEl) zoneEl.textContent = '';

  if (points.length === 0) return;

  // Auto-recognise the Northing / Easting columns so a table read in either
  // order still plots — and so the popups below match the marker positions.
  const oriented = orientNorthingEasting(points);

  const sel = (document.getElementById('utmZoneSelect') as HTMLSelectElement | null)?.value ?? '40N';
  let forcedZone: ZoneSelection | undefined;
  if (sel === 'dltm') {
    forcedZone = 'dltm';
  } else if (sel !== 'auto') {
    const zone = parseInt(sel);
    const south = sel.endsWith('S');
    forcedZone = { zone, south };
  }

  const result = convertPoints(oriented, forcedZone);

  if (!result) {
    if (zoneEl) zoneEl.textContent = 'Unknown — Cannot display';
    const map = block.getMap();
    L.popup({ closeButton: false })
      .setLatLng(map.getCenter())
      .setContent('<b>Cannot display on map.</b><br>Coordinate system not recognized (expected UTM zones 30–42 or geographic lat/lon).')
      .openOn(map);
    return;
  }

  const { latLons, label } = result;
  if (zoneEl) zoneEl.textContent = label;

  block.setMarkers(
    oriented.map((pt, i) => ({
      id: pt.pointNumber + '#' + i,
      lat: latLons[i][0],
      lng: latLons[i][1],
      label: pt.pointNumber,
      popupHtml:
        `<b>${escHtml(pt.pointNumber)}</b>` +
        `<br>N: ${pt.northing.toFixed(3)}` +
        `<br>E: ${pt.easting.toFixed(3)}` +
        (pt.elevation !== null ? `<br>Z: ${pt.elevation.toFixed(3)}` : ''),
    })),
    { fit: true },
  );
}

export function invalidateMapSize(): void {
  block?.invalidateSize();
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
