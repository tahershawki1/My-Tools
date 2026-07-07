// ─── Domain types ────────────────────────────────────────────────

/** A single extracted survey point. */
export interface SurveyPoint {
  /** Point identifier as it appears in the PDF (may be numeric or alphanumeric). */
  pointNumber: string;
  easting: number;
  northing: number;
  /** Elevation / RL / height. Null when the column is absent or the cell is empty. */
  elevation: number | null;
  /** 1-based page number the row was found on. */
  pageNumber: number;
  /** 0-based order index across all pages. */
  rowIndex: number;
  /** How many times this point appeared in the raw data (duplicates ignored). */
  count: number;
  /** Raw text items that were parsed to produce this point (used for PDF highlighting). */
  sourceItems?: RawTextItem[];
}

// ─── PDF-layer types ─────────────────────────────────────────────

/** A single text fragment returned by pdf.js, enriched with page info. */
export interface RawTextItem {
  text: string;
  x: number;      // left edge in PDF-point units
  y: number;      // baseline Y in PDF-point units (origin = page bottom-left)
  width: number;
  height: number; // glyph height in PDF-point units (≈ font size × scale)
  pageNumber: number;
}

/** A horizontal row reassembled from RawTextItems. */
export interface TextRow {
  /** Topmost (maximum) Y of all items (used for ordering rows). */
  y: number;
  /** Items sorted left→right. */
  items: RawTextItem[];
  /** Full row text (items joined with a single space). */
  text: string;
  pageNumber: number;
}

// ─── Column-detection types ───────────────────────────────────────

export type ColumnKind = 'point' | 'easting' | 'northing' | 'elevation' | 'unknown';

/** Describes one column detected from the header row. */
export interface ColumnDef {
  kind: ColumnKind;
  /** X centre of the header cell; used for spatial assignment of data cells. */
  xCenter: number;
  /** Original header label for diagnostics. */
  label: string;
}

// ─── Result types ─────────────────────────────────────────────────

export interface ParseResult {
  points: SurveyPoint[];
  pageCount: number;
  /** Non-fatal warnings accumulated during parsing. */
  warnings: string[];
}

// ─── Point Signing tool ────────────────────────────────────────────

export type SignStatus = 'pending' | 'signed' | 'obstructed';

/** A survey point placed on the map for field sign-off. */
export interface SignPoint {
  id: number;            // stable index into the original uploaded list
  pointNumber: string;
  easting: number;
  northing: number;
  elevation: number | null;
  lat: number;
  lng: number;
  status: SignStatus;
  /** ISO timestamp set when the status moves to 'signed' or 'obstructed'. */
  statusAt: string | null;
}
