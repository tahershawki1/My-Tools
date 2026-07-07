import { describe, it, expect } from 'vitest';
import { parseCsv, baseName } from './exporter';

describe('parseCsv', () => {
  it('does not mistake "Northing" for the short "no" point-id keyword', () => {
    // Regression: substring matching made "northing".includes("no") true,
    // so the Northing column was read as the Point column.
    const csv = 'Northing,Easting,Point\n2700000.1,500000.2,P1\n2700010.3,500020.4,P2';
    const points = parseCsv(csv);
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({ pointNumber: 'P1', northing: 2700000.1, easting: 500000.2 });
    expect(points[1]).toMatchObject({ pointNumber: 'P2', northing: 2700010.3, easting: 500020.4 });
  });

  it('round-trips the signing-report CSV header', () => {
    const csv = 'Point,Status,Time,Northing,Easting,Elevation\nP9,signed,2026-01-01,2700000.5,500000.6,12.34';
    const points = parseCsv(csv);
    expect(points[0]).toMatchObject({
      pointNumber: 'P9', northing: 2700000.5, easting: 500000.6, elevation: 12.34,
    });
  });

  it('matches short single-letter headers exactly, not as substrings', () => {
    const csv = 'Pt,N,E,Z\nA1,2700001.1,500001.1,9.9';
    const points = parseCsv(csv);
    expect(points[0]).toMatchObject({
      pointNumber: 'A1', northing: 2700001.1, easting: 500001.1, elevation: 9.9,
    });
  });

  it('throws when Point/Northing/Easting columns are missing', () => {
    const csv = 'Foo,Bar\n1,2';
    expect(() => parseCsv(csv)).toThrow();
  });

  it('skips rows with unparsable coordinates', () => {
    const csv = 'Point,Northing,Easting\nP1,2700000.1,500000.2\nP2,n/a,500000.3';
    const points = parseCsv(csv);
    expect(points).toHaveLength(1);
    expect(points[0].pointNumber).toBe('P1');
  });
});

describe('baseName', () => {
  it('strips a .pdf extension and sanitizes unsafe characters', () => {
    expect(baseName('My Survey (final).pdf')).toBe('My Survey _final_');
  });
});
