// Differential Leveling Tool

export interface LevelingRow {
  id: number;
  station: string;
  bs: number | null;  // Backsight
  is: number | null;  // Intermediate Sight
  fs: number | null;  // Foresight
  hi: number | null;  // Height of Instrument (calculated)
  elevation: number | null; // calculated
  error?: string;
}

export interface LevelingResult {
  rows: LevelingRow[];
  sumBS: number;
  sumFS: number;
  firstElev: number;
  lastElev: number;
  checkOk: boolean;
  checkDiff: number;
}

let nextId = 1;

export function createRow(station = '', bs: number | null = null, is_: number | null = null, fs: number | null = null): LevelingRow {
  return { id: nextId++, station, bs, is: is_, fs, hi: null, elevation: null };
}

export function calculate(rows: LevelingRow[], bmElev: number): LevelingResult {
  let currentHI: number | null = null;
  let currentElev: number = bmElev;
  let sumBS = 0;
  let sumFS = 0;
  let firstElev = bmElev;
  let lastElev = bmElev;

  const computed = rows.map((row, i): LevelingRow => {
    const r = { ...row, hi: null as number | null, elevation: null as number | null, error: undefined as string | undefined };
    const hasBS = r.bs !== null && !isNaN(r.bs as number);
    const hasIS = r.is !== null && !isNaN(r.is as number);
    const hasFS = r.fs !== null && !isNaN(r.fs as number);

    // Validate: only one of IS/FS (not both)
    if (hasIS && hasFS) {
      r.error = 'Cannot enter both Intermediate and Foresight in same row';
      return r;
    }

    // If has FS first (turning point or last), compute elevation from current HI
    if (hasFS) {
      if (currentHI === null) { r.error = 'No Height of Instrument — enter Backsight first'; return r; }
      currentElev = currentHI - (r.fs as number);
      sumFS += r.fs as number;
      r.elevation = currentElev;
      lastElev = currentElev;
    }

    // If has BS, compute new HI
    if (hasBS) {
      if (i === 0 || hasFS) {
        // First row uses BM elev; turning points use FS-computed elev
        currentHI = currentElev + (r.bs as number);
      } else if (r.elevation !== null) {
        currentHI = r.elevation + (r.bs as number);
      } else {
        currentHI = currentElev + (r.bs as number);
      }
      sumBS += r.bs as number;
      r.hi = currentHI;
      // If this row has only BS (no FS), elevation stays same as previous
      if (!hasFS && !hasIS) {
        r.elevation = currentElev;
        if (i === 0) { r.elevation = bmElev; firstElev = bmElev; }
      }
    }

    // If has IS — a side shot: it gets its own elevation but must NOT move the
    // running elevation or lastElev, otherwise the arithmetic check
    // (ΣBS − ΣFS = last − first) fails whenever an IS follows the last FS.
    if (hasIS) {
      if (currentHI === null) { r.error = 'No Height of Instrument — enter Backsight first'; return r; }
      r.elevation = currentHI - (r.is as number);
    }

    // First row without FS: set elevation to BM
    if (i === 0 && !hasFS && !hasIS) {
      r.elevation = bmElev;
      firstElev = bmElev;
    }

    // Propagate HI to rows without BS
    if (!hasBS) r.hi = currentHI;

    return r;
  });

  const checkDiff = Math.abs((sumBS - sumFS) - (lastElev - firstElev));
  const checkOk = checkDiff < 0.001;

  return { rows: computed, sumBS, sumFS, firstElev, lastElev, checkOk, checkDiff };
}

export function exportLevelingCsv(result: LevelingResult, bmName: string): void {
  const header = 'Station,Backsight (BS),Intermediate (IS),Foresight (FS),Height of Instr. (HI),Elevation\n';
  const csvField = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const body = result.rows.map(r =>
    [
      csvField(r.station),
      r.bs ?? '',
      r.is ?? '',
      r.fs ?? '',
      r.hi  !== null ? r.hi.toFixed(3)        : '',
      r.elevation !== null ? r.elevation.toFixed(3) : '',
    ].join(',')
  ).join('\n');
  const bom = '﻿';
  const blob = new Blob([bom + header + body], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `leveling_${bmName || 'result'}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
