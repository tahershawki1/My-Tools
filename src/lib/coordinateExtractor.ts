/**
 * coordinateExtractor.ts
 *
 * Converts raw PDF text fragments into an ordered list of SurveyPoints.
 *
 * Design goals (v2)
 * ─────────────────
 * 1. STRICT candidate detection
 *    • Easting and Northing MUST have decimal parts (real survey values do).
 *    • E and N must be within 2 orders of magnitude of each other.
 *    • Point identifier must look like an identifier, not a large float.
 * 2. TWO-PASS outlier removal
 *    After the first pass collects all candidates, a statistical filter
 *    (IQR-based) removes rows whose E or N values are wildly inconsistent
 *    with the majority.  This kills stray page numbers, totals, etc.
 * 3. Column-header-first strategy
 *    When a header row is detected, column X-positions drive value assignment.
 *    Heuristic is used only where no header information is available.
 */

import type {
  RawTextItem,
  TextRow,
  SurveyPoint,
  ColumnDef,
  ColumnKind,
  ParseResult,
} from './types';

// ── Constants ─────────────────────────────────────────────────────────────────

// Conservative: 2 pts ≈ 0.7 mm. Avoids merging adjacent rows in dense tables.
// Survey tables typically have 12-16 pt row height, so 2 pt tolerance is safe.
const ROW_Y_TOLERANCE = 2;

const HEADER_MAP: Record<string, ColumnKind> = {
  point: 'point', 'point no': 'point', 'point#': 'point', pt: 'point',
  'point number': 'point', no: 'point', id: 'point', name: 'point',
  easting: 'easting', east: 'easting', e: 'easting', x: 'easting',
  northing: 'northing', north: 'northing', n: 'northing', y: 'northing',
  elevation: 'elevation', elev: 'elevation', rl: 'elevation',
  height: 'elevation', z: 'elevation', ht: 'elevation',
  alt: 'elevation', 'elev.': 'elevation',
};

// ── Row grouping ──────────────────────────────────────────────────────────────

export function groupIntoRows(items: RawTextItem[]): TextRow[] {
  if (items.length === 0) return [];

  // Sort Y descending (high Y = top of PDF page = first row to read).
  // Secondary sort by X so items within a row are left→right.
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);

  const rows: TextRow[] = [];
  let bucket: RawTextItem[] = [sorted[0]];
  // Track the TOP (highest) Y seen in the current bucket.
  // New items join the bucket only if they are within ROW_Y_TOLERANCE below
  // the bucket top — this prevents cascade-merging of adjacent rows.
  let bucketTopY = sorted[0].y;

  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];
    // bucketTopY >= item.y always (sorted desc), so this is just bucketTopY - item.y
    if (bucketTopY - item.y <= ROW_Y_TOLERANCE) {
      bucket.push(item);
    } else {
      rows.push(buildRow(bucket));
      bucket = [item];
      bucketTopY = item.y; // reset to the new bucket's top
    }
  }
  rows.push(buildRow(bucket));

  // Explicit Y-descending sort guarantees reading order even if any bucket
  // was assembled in a non-sequential way due to PDF stream ordering.
  return rows.sort((a, b) => b.y - a.y);
}

function buildRow(items: RawTextItem[]): TextRow {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  // Use the MAXIMUM Y of all items (the topmost baseline in the row).
  // This is a stable reference for row ordering and avoids distortion
  // from mixed font sizes or superscripts pulling the average down.
  const maxY = Math.max(...items.map((i) => i.y));
  const text = sorted.map((i) => i.text).join(' ');
  return { y: maxY, items: sorted, text, pageNumber: items[0].pageNumber };
}

// ── Header detection ──────────────────────────────────────────────────────────

function isHeaderRow(row: TextRow): boolean {
  // Pad with spaces so the " keyword" patterns below also match a keyword that
  // sits at the very start or end of the row text.
  const lower = ` ${row.text.toLowerCase()} `;

  // A row qualifies as a header only when it contains at least TWO distinct
  // coordinate-column keywords.  Single-keyword matches (e.g. just "point")
  // are too broad and catch description rows in data tables.
  let score = 0;
  if (lower.includes('easting')  || lower.includes(' east')) score++;
  if (lower.includes('northing') || lower.includes(' north')) score++;
  if (lower.includes('elevation') || lower.includes(' elev') ||
      / \brl\b/.test(lower) || / \bz\b/.test(lower)) score++;
  if (lower.includes('point') || / \bpt\b/.test(lower) ||
      / \bno\b\.?/.test(lower) || / \bid\b/.test(lower)) score++;
  // E / N as standalone column labels (e.g. "Pt  E  N  Z")
  if (/ \be\b/.test(lower) && / \bn\b/.test(lower)) score += 2;

  return score >= 2;
}

function parseHeaderRow(row: TextRow): ColumnDef[] {
  const defs: ColumnDef[] = [];
  for (const item of row.items) {
    const label = item.text.trim();
    const key = label.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    const kind: ColumnKind = HEADER_MAP[key] ?? 'unknown';
    defs.push({ kind, xCenter: item.x + item.width / 2, label });
  }
  const kinds = defs.map((d) => d.kind);
  return kinds.includes('easting') && kinds.includes('northing') ? defs : [];
}

// ── Number utilities ──────────────────────────────────────────────────────────

/**
 * Strip thousands-separators and normalise decimal comma.
 * e.g.  "1,234,567.89"  →  "1234567.89"
 *       "1.234.567,89"  →  "1234567.89"
 */
function normaliseNumStr(s: string): string {
  // Allow leading minus so negative elevations (e.g. "-1.234,56") are handled.
  const commaLast =
    /^-?[\d.,]+$/.test(s) &&
    s.lastIndexOf(',') > s.lastIndexOf('.');
  return commaLast
    ? s.replace(/\./g, '').replace(/,/g, '.')
    : s.replace(/,/g, '');
}

function tryParseFloat(s: string): number | null {
  const n = parseFloat(normaliseNumStr(s));
  return isNaN(n) ? null : n;
}

/** True when a token string contains a decimal point followed by digits. */
function hasDecimalPart(token: string): boolean {
  return /\.\d+/.test(normaliseNumStr(token));
}

/** True when a token could be a point identifier (not a large coordinate). */
function looksLikeIdentifier(token: string): boolean {
  // Only reject purely-numeric tokens that look like decimal coordinates.
  // Alphanumeric tokens such as "P.1" or "A.2" contain a dot but are valid
  // identifiers — do not reject them.
  if (/^-?[\d.,]+$/.test(token) && hasDecimalPart(token)) return false;
  // Accept integers (point numbers) or short alphanumeric codes
  return /^[A-Za-z0-9\-_.]+$/.test(token) && token.length <= 20;
}

/** Two numbers are "same scale" if ratio ≤ 100 (within 2 orders of magnitude). */
function sameScale(a: number, b: number): boolean {
  // A zero coordinate is valid (e.g. a point on the origin axis).
  if (a === 0 || b === 0) return true;
  const ratio = Math.max(Math.abs(a), Math.abs(b)) / Math.min(Math.abs(a), Math.abs(b));
  return ratio <= 100;
}

/** Number of digits in the integer part of a value (sign ignored). */
function integerDigitCount(value: number): number {
  return Math.abs(Math.trunc(value)).toString().length;
}

/**
 * Local survey convention: Northing has 7 integer digits, Easting has 6.
 * Column order or X-position assignment can come out swapped (e.g. tables
 * that list Northing before Easting); use the digit count to put each
 * value back in its correct field.
 */
function fixEastingNorthingBySize(
  easting: number,
  northing: number,
): { easting: number; northing: number } {
  if (integerDigitCount(easting) === 7 && integerDigitCount(northing) === 6) {
    return { easting: northing, northing: easting };
  }
  return { easting, northing };
}

// ── Column-based parsing (used when header was detected) ──────────────────────

function assignToColumns(
  items: RawTextItem[],
  cols: ColumnDef[],
): Partial<Record<ColumnKind, string>> {
  const result: Partial<Record<ColumnKind, string>> = {};
  for (const item of items) {
    const cx = item.x + item.width / 2;
    let best = cols[0];
    let bestDist = Math.abs(cx - cols[0].xCenter);
    for (const col of cols.slice(1)) {
      const d = Math.abs(cx - col.xCenter);
      if (d < bestDist) { bestDist = d; best = col; }
    }
    if (best.kind !== 'unknown') {
      result[best.kind] = ((result[best.kind] ?? '') + ' ' + item.text).trim();
    }
  }
  return result;
}

function parseWithColumns(
  row: TextRow,
  cols: ColumnDef[],
): Omit<SurveyPoint, 'rowIndex' | 'count'> | null {
  const assigned = assignToColumns(row.items, cols);

  // Strip internal spaces: a PDF can split one number across two text fragments
  // that get concatenated with a space (e.g. "1234" + " .56" → "1234.56").
  // This also prevents the silent-wrong-parse bug where "123 456.78" would pass
  // hasDecimalPart() but parseFloat() would stop at the space and return 123.
  const eastingStr = (assigned.easting ?? '').replace(/\s+/g, '');
  const northingStr = (assigned.northing ?? '').replace(/\s+/g, '');

  // Both E and N must be decimal numbers
  if (!hasDecimalPart(eastingStr) || !hasDecimalPart(northingStr)) return null;

  const eastingRaw = tryParseFloat(eastingStr);
  const northingRaw = tryParseFloat(northingStr);
  if (eastingRaw === null || northingRaw === null) return null;

  // Sanity: E and N must be similar in scale
  if (!sameScale(eastingRaw, northingRaw)) return null;

  const { easting, northing } = fixEastingNorthingBySize(eastingRaw, northingRaw);

  const elevStr = (assigned.elevation ?? '').replace(/\s+/g, '');
  const elevation = elevStr ? (tryParseFloat(elevStr) ?? null) : null;

  return {
    pointNumber: assigned.point?.trim() ?? '',
    easting,
    northing,
    elevation,
    pageNumber: row.pageNumber,
  };
}

// ── Heuristic parsing (no-header fallback) ────────────────────────────────────

/**
 * Strict heuristic:
 *   • E and N MUST be decimal numbers (contain a decimal point).
 *   • E and N must share roughly the same order of magnitude.
 *   • Point identifier, if present, must look like one (not a coordinate itself).
 */
function parseHeuristic(row: TextRow): Omit<SurveyPoint, 'rowIndex' | 'count'> | null {
  const tokens = row.text.trim().split(/\s+/);
  if (tokens.length < 2) return null;

  // Classify every token
  const decimalTokens: { value: number; token: string; idx: number }[] = [];
  const intTokens:     { value: number; token: string; idx: number }[] = [];
  const identTokens:   { token: string; idx: number }[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const normed = normaliseNumStr(t);

    if (hasDecimalPart(t)) {
      const v = tryParseFloat(t);
      if (v !== null) decimalTokens.push({ value: v, token: t, idx: i });
    } else if (/^-?\d+$/.test(normed)) {
      intTokens.push({ value: parseInt(normed, 10), token: t, idx: i });
    } else if (looksLikeIdentifier(t)) {
      identTokens.push({ token: t, idx: i });
    }
  }

  // Need at least 2 decimal numbers to have E and N
  if (decimalTokens.length < 2) return null;

  // Find the best E-N pair: two decimal numbers of similar scale,
  // taken in left-to-right (column) order.
  let ePick: typeof decimalTokens[0] | null = null;
  let nPick: typeof decimalTokens[0] | null = null;

  // Prefer the first two matching-scale decimal numbers (preserves column order)
  for (let i = 0; i < decimalTokens.length - 1; i++) {
    for (let j = i + 1; j < decimalTokens.length; j++) {
      if (sameScale(decimalTokens[i].value, decimalTokens[j].value)) {
        ePick = decimalTokens[i];
        nPick = decimalTokens[j];
        break;
      }
    }
    if (ePick) break;
  }

  if (!ePick || !nPick) return null;

  // Elevation: first remaining decimal number that comes after N
  const usedIdxs = new Set([ePick.idx, nPick.idx]);
  const afterN = decimalTokens.filter(
    (d) => !usedIdxs.has(d.idx) && d.idx > nPick!.idx,
  );
  const elevation = afterN[0]?.value ?? null;

  // Point number: prefer an explicit identifier token that appears before E,
  // then fall back to an integer token before E.
  const firstCoordIdx = Math.min(ePick.idx, nPick.idx);
  const pointToken =
    identTokens.find((t) => t.idx < firstCoordIdx)?.token ??
    identTokens[0]?.token ??
    intTokens.find((n) => n.idx < firstCoordIdx && n.value < 100_000)?.token ??
    null;

  // Return '' when no identifier was found; caller assigns a sequential number.
  const pointNumber = pointToken ?? '';

  const { easting, northing } = fixEastingNorthingBySize(ePick.value, nPick.value);

  return {
    pointNumber,
    easting,
    northing,
    elevation,
    pageNumber: row.pageNumber,
  };
}

// ── Duplicate removal (post-processing) ──────────────────────────────────────

/**
 * Count occurrences of identical E, N, Z coordinates.
 * Keep ALL points but add count to track duplicates.
 */
function removeDuplicates(points: SurveyPoint[]): { points: SurveyPoint[]; dupCount: number } {
  // Count how many times each coordinate set appears
  const counts = new Map<string, number>();

  for (const pt of points) {
    const key = `${pt.easting.toFixed(6)}_${pt.northing.toFixed(6)}_${pt.elevation?.toFixed(6) ?? 'null'}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // Attach count to each point (total occurrences, not per-instance)
  const result = points.map(pt => {
    const key = `${pt.easting.toFixed(6)}_${pt.northing.toFixed(6)}_${pt.elevation?.toFixed(6) ?? 'null'}`;
    return { ...pt, count: counts.get(key) ?? 1 };
  });

  // Count duplicates (points that appear more than once)
  const dupCount = Array.from(counts.values()).filter(c => c > 1).reduce((a, b) => a + b, 0);

  return { points: result, dupCount };
}

// ── Outlier removal (post-processing) ────────────────────────────────────────

/**
 * After the first pass, use the IQR method to remove any rows whose
 * Easting or Northing is wildly different from the bulk of the data.
 *
 * Works well even for small datasets (≥ 4 points).  Uses a generous
 * multiplier (k = 5) to avoid discarding legitimate boundary points.
 */
function removeOutliers(points: SurveyPoint[]): SurveyPoint[] {
  if (points.length < 4) return points;

  function iqrFence(values: number[], k = 5): [number, number] {
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    const q1 = sorted[Math.floor(n * 0.25)];
    const q3 = sorted[Math.floor(n * 0.75)];
    const iqr = q3 - q1;
    return [q1 - k * iqr, q3 + k * iqr];
  }

  const [eMin, eMax] = iqrFence(points.map((p) => p.easting));
  const [nMin, nMax] = iqrFence(points.map((p) => p.northing));

  return points.filter(
    (p) =>
      p.easting  >= eMin && p.easting  <= eMax &&
      p.northing >= nMin && p.northing <= nMax,
  );
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function extractCoordinates(
  allItems: RawTextItem[],
  pageCount: number,
): ParseResult {
  console.log('[Extractor] Starting coordinate extraction from', allItems.length, 'items,', pageCount, 'pages');
  const warnings: string[] = [];
  const candidates: Omit<SurveyPoint, 'rowIndex' | 'count'>[] = [];

  // Sequential counter for rows that have no explicit point identifier.
  // Incremented only when the counter is actually used, so there are no gaps.
  let autoPointCounter = 0;

  // columnDefs is declared OUTSIDE the page loop so that column positions
  // detected on page 1 are reused on page 2, 3 … for tables that continue
  // across pages without repeating the header row.
  let columnDefs: ColumnDef[] = [];

  for (let page = 1; page <= pageCount; page++) {
    const pageItems = allItems.filter((i) => i.pageNumber === page);
    if (pageItems.length === 0) continue;

    const rows = groupIntoRows(pageItems);
    console.log(`[Extractor] Page ${page}: ${rows.length} rows detected`);
    let headerFoundOnPage = false;

    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      const trimmedText = row.text.trim();

      if (trimmedText.length < 3) {
        console.log(`[Extractor] Row ${rowIdx}: SKIPPED (too short, length ${trimmedText.length})`);
        continue;
      }

      // Re-check for a header on every page — handles tables that repeat the
      // header at the top of each page, or tables with a mid-table sub-header.
      if (isHeaderRow(row)) {
        console.log(`[Extractor] Row ${rowIdx}: HEADER detected - "${trimmedText.substring(0, 50)}..."`);
        const defs = parseHeaderRow(row);
        if (defs.length > 0) {
          columnDefs = defs;       // update (may override a previous page's defs)
          headerFoundOnPage = true;
          console.log(`[Extractor]   → Columns: ${defs.map(d => d.kind).join(', ')}`);
        }
        continue; // never parse a header row as data
      }

      // Column-based is authoritative when we have defs; heuristic is fallback.
      const pt =
        (columnDefs.length > 0 ? parseWithColumns(row, columnDefs) : null) ??
        parseHeuristic(row);

      if (pt !== null) {
        const withSource = { ...pt, sourceItems: row.items };
        if (!withSource.pointNumber) {
          candidates.push({ ...withSource, pointNumber: String(++autoPointCounter) });
          console.log(`[Extractor] Row ${rowIdx}: DATA point #${autoPointCounter} - E:${pt.easting.toFixed(2)} N:${pt.northing.toFixed(2)}`);
        } else {
          candidates.push(withSource);
          console.log(`[Extractor] Row ${rowIdx}: DATA point ${pt.pointNumber} - E:${pt.easting.toFixed(2)} N:${pt.northing.toFixed(2)}`);
        }
      } else {
        console.log(`[Extractor] Row ${rowIdx}: NO MATCH - "${trimmedText.substring(0, 40)}..."`);
      }
    }

    if (!headerFoundOnPage && columnDefs.length === 0) {
      warnings.push(
        `Page ${page}: no column header detected — used heuristic parsing.`,
      );
    }
  }

  // Assign temporary rowIndex so removeDuplicates can receive SurveyPoint[]
  const withIdx: SurveyPoint[] = candidates.map((pt, i) => ({ ...pt, rowIndex: i, count: 1 }));

  // Keep ALL duplicate points (same E, N, Z) - assign count to each
  const { points: withDupCounts, dupCount } = removeDuplicates(withIdx);

  // Post-processing: remove statistical outliers introduced by stray numbers
  // (operates on all instances, including duplicates)
  const cleaned = removeOutliers(withDupCounts);

  if (dupCount > 0) {
    warnings.push(
      `${dupCount} duplicate point${dupCount !== 1 ? 's' : ''} found (same coordinates) - all kept.`,
    );
  }

  if (cleaned.length < withDupCounts.length) {
    warnings.push(
      `${withDupCounts.length - cleaned.length} row(s) removed as statistical outliers.`,
    );
  }

  // Re-assign final sequential indices
  const points: SurveyPoint[] = cleaned.map((pt, i) => ({ ...pt, rowIndex: i }));

  console.log('[Extractor] Found', points.length, 'final points from', candidates.length, 'candidates');

  if (points.length === 0) {
    warnings.push(
      'No coordinate rows found. Ensure the PDF contains a survey table ' +
      'with decimal Easting / Northing values.',
    );
  }

  return { points, pageCount, warnings };
}
