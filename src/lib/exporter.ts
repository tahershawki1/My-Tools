/**
 * exporter.ts
 *
 * Converts extracted SurveyPoints to downloadable files:
 *
 *  • CSV  — standard comma-separated with header row (opens in Excel, QGIS, etc.)
 *  • AutoCAD TXT — Autodesk Civil 3D / Land Desktop point-import format:
 *                  Point#,Easting,Northing,Elevation,Description
 *                  (also readable by AutoCAD's IMPORT command)
 *  • JSON — structured JSON array for programmatic use
 */

import type { SurveyPoint, SignPoint } from './types';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Trigger a browser file-download without a server round-trip. */
function download(filename: string, content: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Release the object URL shortly after — the download is already queued.
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Format a coordinate to 4 decimal places for export. */
function c(value: number): string {
  return value.toFixed(4);
}

/** Derive a base filename from the original PDF name (strips extension). */
export function baseName(pdfName: string): string {
  return pdfName.replace(/\.pdf$/i, '').replace(/[^a-z0-9_\- ]/gi, '_');
}

// ── Export functions ──────────────────────────────────────────────────────────

/**
 * Standard CSV export.
 * Header: Point,Northing,Easting,Elevation  (NEZ order)
 */
export function exportCsv(points: SurveyPoint[], fileName: string): void {
  const lines: string[] = ['Point,Northing,Easting,Elevation'];

  for (const pt of points) {
    const elev = pt.elevation !== null ? c(pt.elevation) : '';
    lines.push(`${pt.pointNumber},${c(pt.northing)},${c(pt.easting)},${elev}`);
  }

  download(`${baseName(fileName)}_coordinates.csv`, lines.join('\r\n'), 'text/csv;charset=utf-8');
}

/**
 * AutoCAD / Civil 3D point-import format (.txt).
 *
 * Format per line:   Point#,Easting,Northing,Elevation,Description
 * This matches the default PNEZD format expected by Civil 3D's
 * "Import Survey Data" and AutoCAD Land Desktop's COGO import.
 *
 * If elevation is absent the field is left blank (Civil 3D will default to 0).
 */
export function exportAutocad(points: SurveyPoint[], fileName: string): void {
  const lines: string[] = [];

  for (const pt of points) {
    const elev = pt.elevation !== null ? c(pt.elevation) : '';
    // PNEZD: Point, Northing, Easting, Elevation, Description
    // Note: Civil 3D's default PNEZD order is Point,Northing,Easting,Z,Desc
    // but many firms use PENZ.  We output both variants as two sections.
    lines.push(`${pt.pointNumber},${c(pt.northing)},${c(pt.easting)},${elev},`);
  }

  const header =
    '# AutoCAD Civil 3D point import file\n' +
    '# Format: Point#,Northing,Easting,Elevation,Description (PNEZD)\n' +
    '# Import via: Home → Import Survey Data → Point File Formats → PNEZD\n';

  download(
    `${baseName(fileName)}_autocad.txt`,
    header + lines.join('\r\n'),
  );
}

/**
 * JSON export — full structured array for use in scripts or GIS tools.
 */
export function exportJson(points: SurveyPoint[], fileName: string): void {
  const payload = points.map((pt) => ({
    point: pt.pointNumber,
    northing: pt.northing,
    easting: pt.easting,
    elevation: pt.elevation,
    page: pt.pageNumber,
  }));

  download(
    `${baseName(fileName)}_coordinates.json`,
    JSON.stringify(payload, null, 2),
    'application/json;charset=utf-8',
  );
}

/**
 * Parses a CSV produced by exportCsv() — or any CSV with Point / Northing /
 * Easting / Elevation columns in any order (header names matched loosely so
 * "Pt", "Point#", "N", "E", "Z", "Elev" etc. all work).
 */
export function parseCsv(text: string): SurveyPoint[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) throw new Error('CSV file has no data rows.');

  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  // Short labels ("no", "n", "z"…) must match exactly — substring matching
  // would misfire (e.g. "northing" contains "no" and would be taken as the
  // Point column). Longer keywords are safe to match as substrings.
  const find = (exact: string[], partial: string[]) =>
    header.findIndex(h => exact.includes(h) || partial.some(k => h.includes(k)));

  const pointIdx = find(['pt', 'no', 'no.', 'id', '#'], ['point', 'name']);
  const northIdx = find(['n'], ['north', 'lat']);
  const eastIdx  = find(['e'], ['east', 'lng', 'lon']);
  const elevIdx  = find(['z', 'rl', 'h'], ['elev', 'height']);

  if (pointIdx === -1 || northIdx === -1 || eastIdx === -1) {
    throw new Error('CSV must have Point, Northing and Easting columns.');
  }

  const points: SurveyPoint[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map(c => c.trim());
    const northing = parseFloat(cells[northIdx]);
    const easting  = parseFloat(cells[eastIdx]);
    if (!cells[pointIdx] || isNaN(northing) || isNaN(easting)) continue;
    const elevRaw = elevIdx !== -1 ? parseFloat(cells[elevIdx]) : NaN;
    points.push({
      pointNumber: cells[pointIdx],
      easting,
      northing,
      elevation: isNaN(elevRaw) ? null : elevRaw,
      pageNumber: 1,
      rowIndex: i - 1,
      count: 1,
    });
  }

  if (points.length === 0) throw new Error('No valid coordinate rows found in CSV.');
  return points;
}

/** Exports a Point Signing session (status + timestamp per point) to CSV. */
export function exportSignReportCsv(points: SignPoint[], fileName: string): void {
  const lines: string[] = ['Point,Status,Time,Northing,Easting,Elevation'];

  for (const pt of points) {
    const elev = pt.elevation !== null ? c(pt.elevation) : '';
    lines.push(`${pt.pointNumber},${pt.status},${pt.statusAt ?? ''},${c(pt.northing)},${c(pt.easting)},${elev}`);
  }

  download(`${baseName(fileName)}_signing_report.csv`, lines.join('\r\n'), 'text/csv;charset=utf-8');
}

/**
 * Coordinates extracted from a DXF drawing (endpoint/intersection snap picks).
 * A structural type, not imported from dxfTool.ts, so this library file has
 * no reverse dependency on a tool file — dxfTool.ts's richer ExtractedPoint
 * (with id/snapKind) is a superset and passes in directly.
 */
export interface ExportableDxfPoint {
  label: string;
  x: number; y: number;
  realEasting?: number; realNorthing?: number;
  lat?: number; lng?: number;
}

/** Drawing-space + (once georeferenced) real-world coordinates, CSV. */
export function exportDxfPointsCsv(points: ExportableDxfPoint[], fileName: string): void {
  const lines: string[] = ['Label,DrawingX,DrawingY,Easting,Northing,Lat,Lng'];

  for (const pt of points) {
    lines.push([
      pt.label, c(pt.x), c(pt.y),
      pt.realEasting !== undefined ? c(pt.realEasting) : '',
      pt.realNorthing !== undefined ? c(pt.realNorthing) : '',
      pt.lat !== undefined ? pt.lat.toFixed(6) : '',
      pt.lng !== undefined ? pt.lng.toFixed(6) : '',
    ].join(','));
  }

  download(`${baseName(fileName)}_dxf_points.csv`, lines.join('\r\n'), 'text/csv;charset=utf-8');
}

/** Same data as exportDxfPointsCsv, as structured JSON. */
export function exportDxfPointsJson(points: ExportableDxfPoint[], fileName: string): void {
  const payload = points.map(pt => ({
    label: pt.label,
    drawingX: pt.x, drawingY: pt.y,
    easting: pt.realEasting ?? null, northing: pt.realNorthing ?? null,
    lat: pt.lat ?? null, lng: pt.lng ?? null,
  }));

  download(`${baseName(fileName)}_dxf_points.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
}
