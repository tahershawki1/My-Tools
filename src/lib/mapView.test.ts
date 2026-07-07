import { describe, it, expect } from 'vitest';
import { orientNorthingEasting, convertSurveyPoints } from './mapView';
import type { SurveyPoint } from './types';

function pt(pointNumber: string, easting: number, northing: number): SurveyPoint {
  return { pointNumber, easting, northing, elevation: null, pageNumber: 1, rowIndex: 0, count: 1 };
}

describe('orientNorthingEasting', () => {
  it('leaves correctly-ordered points unchanged', () => {
    const points = [pt('P1', 500000.1, 2700000.2), pt('P2', 500010.3, 2700010.4)];
    const result = orientNorthingEasting(points);
    expect(result[0].easting).toBeCloseTo(500000.1);
    expect(result[0].northing).toBeCloseTo(2700000.2);
  });

  it('swaps a majority-out-of-range easting/northing pair', () => {
    // Easting slot holds a 7-digit value (too big to be an Easting) while the
    // Northing slot holds a plausible Easting — the columns were read swapped.
    const points = [pt('P1', 2700000.1, 500000.2), pt('P2', 2700010.3, 500010.4)];
    const result = orientNorthingEasting(points);
    expect(result[0].easting).toBeCloseTo(500000.2);
    expect(result[0].northing).toBeCloseTo(2700000.1);
  });

  it('leaves geographic (small-magnitude) coordinates alone — the test is inconclusive there', () => {
    const points = [pt('P1', 55.3, 24.5)];
    const result = orientNorthingEasting(points);
    expect(result[0].easting).toBeCloseTo(55.3);
    expect(result[0].northing).toBeCloseTo(24.5);
  });
});

describe('convertSurveyPoints', () => {
  it('passes through geographic lat/lon points unchanged', () => {
    const points = [pt('P1', 55.3, 24.5)];
    const conv = convertSurveyPoints(points, 'auto');
    expect(conv).not.toBeNull();
    expect(conv!.label).toMatch(/geographic/i);
    expect(conv!.latLons[0]).toEqual([24.5, 55.3]);
  });

  it('converts a forced UTM zone to a plausible lat/lon', () => {
    const points = [pt('P1', 500000, 2700000)];
    const conv = convertSurveyPoints(points, '40N');
    expect(conv).not.toBeNull();
    const [lat, lng] = conv!.latLons[0];
    expect(lat).toBeGreaterThan(0);
    expect(lat).toBeLessThan(90);
    expect(lng).toBeGreaterThan(-180);
    expect(lng).toBeLessThan(180);
  });

  it('returns null for a point list with no recognizable coordinate system', () => {
    const points = [pt('P1', 99_999_999, 1)];
    const conv = convertSurveyPoints(points, 'auto');
    expect(conv).toBeNull();
  });
});
