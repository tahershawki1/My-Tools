import { describe, it, expect } from 'vitest';
import { extractCoordinates } from './coordinateExtractor';
import type { RawTextItem } from './types';

function item(text: string, x: number, y: number, width = text.length * 6): RawTextItem {
  return { text, x, y, width, height: 10, pageNumber: 1 };
}

describe('extractCoordinates', () => {
  it('recognizes a compact single-letter header ("N E") even with no leading space', () => {
    // Regression: isHeaderRow's keyword regexes required a literal space
    // before the word (e.g. / \bn\b/), so a keyword sitting at the very
    // start of the row text (no preceding space) was missed and the table
    // silently fell back to heuristic parsing.
    const items: RawTextItem[] = [
      item('N', 90, 100, 40),   // header col N, center x = 110
      item('E', 190, 100, 40),  // header col E, center x = 210
      item('2700000.500', 90, 90, 40),  // data row 1, aligned under N
      item('500000.750', 190, 90, 40),  // data row 1, aligned under E
      item('2700010.250', 90, 80, 40),  // data row 2, aligned under N
      item('500010.125', 190, 80, 40),  // data row 2, aligned under E
    ];
    const result = extractCoordinates(items, 1);
    expect(result.points).toHaveLength(2);
    expect(result.points[0]).toMatchObject({ northing: 2700000.5, easting: 500000.75 });
    expect(result.points[1]).toMatchObject({ northing: 2700010.25, easting: 500010.125 });
    expect(result.warnings.join(' ')).not.toMatch(/no column header detected/i);
  });

  it('parses a fully-labeled header with a point column and elevation', () => {
    const items: RawTextItem[] = [
      item('Point', 10, 100, 40),
      item('Easting', 60, 100, 60),
      item('Northing', 130, 100, 70),
      item('Elevation', 210, 100, 70),
      item('P1', 10, 90, 40),
      item('500123.456', 60, 90, 60),
      item('2700456.789', 130, 90, 70),
      item('12.345', 210, 90, 70),
    ];
    const result = extractCoordinates(items, 1);
    expect(result.points).toHaveLength(1);
    expect(result.points[0]).toMatchObject({
      pointNumber: 'P1', easting: 500123.456, northing: 2700456.789, elevation: 12.345,
    });
  });

  it('falls back to heuristic parsing and warns when no header row is present', () => {
    const items: RawTextItem[] = [
      item('P1 500000.100 2700000.200', 10, 100, 200),
      item('P2 500010.300 2700010.400', 10, 90, 200),
    ];
    const result = extractCoordinates(items, 1);
    expect(result.points.length).toBeGreaterThan(0);
    expect(result.warnings.join(' ')).toMatch(/no column header detected/i);
  });
});
