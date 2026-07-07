import { describe, it, expect } from 'vitest';
import { parseDxf } from './dxfParser';

// Minimal hand-written ASCII DXF: one LINE, one LWPOLYLINE with a bulge=1
// (exact semicircle) segment, and one CIRCLE. No HEADER section, so units
// resolve to 'unknown' (scale 1, i.e. treated as meters) and bounds are
// computed from the segments rather than $EXTMIN/$EXTMAX.
const SAMPLE_DXF = `0
SECTION
2
ENTITIES
0
LINE
8
0
10
0.0
20
0.0
30
0.0
11
10.0
21
0.0
31
0.0
0
LWPOLYLINE
8
0
90
2
70
0
10
100.0
20
0.0
30
0.0
42
1.0
10
102.0
20
0.0
30
0.0
0
CIRCLE
8
0
10
50.0
20
50.0
30
0.0
40
5.0
0
ENDSEC
0
EOF
`;

describe('parseDxf', () => {
  it('flattens a LINE entity into a single segment', () => {
    const result = parseDxf(SAMPLE_DXF);
    const lineSeg = result.segments.find(s => s.x1 === 0 && s.y1 === 0 && s.x2 === 10);
    expect(lineSeg).toBeDefined();
    expect(lineSeg!.y2).toBeCloseTo(0);
  });

  it('rasterizes a bulge=1 (semicircle) LWPOLYLINE segment through the correct arc side', () => {
    const result = parseDxf(SAMPLE_DXF);
    // Semicircle from (100,0) to (102,0), bulge=+1 → CCW traversal, radius 1,
    // center (101,0); by the DXF CCW-traversal convention this dips through
    // (101,-1), not (101,1) — see the derivation note in dxfParser.ts.
    const arcPts = result.segments
      .filter(s => s.x1 >= 99.9 && s.x1 <= 102.1 && s.x2 >= 99.9 && s.x2 <= 102.1)
      .flatMap(s => [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }]);
    expect(arcPts.some(p => p.y < -0.9)).toBe(true);
    expect(arcPts.every(p => p.y < 0.1)).toBe(true); // never bulges upward
  });

  it('rasterizes a CIRCLE into a closed polygon of the right radius', () => {
    const result = parseDxf(SAMPLE_DXF);
    const circleSegs = result.segments.filter(s =>
      Math.hypot(s.x1 - 50, s.y1 - 50) < 5.1 && Math.hypot(s.x1 - 50, s.y1 - 50) > 4.9,
    );
    expect(circleSegs.length).toBeGreaterThan(10);
    for (const s of circleSegs) {
      expect(Math.hypot(s.x1 - 50, s.y1 - 50)).toBeCloseTo(5, 1);
    }
  });

  it('computes bounds from segments when $EXTMIN/$EXTMAX are absent', () => {
    const result = parseDxf(SAMPLE_DXF);
    expect(result.bounds).not.toBeNull();
    expect(result.bounds!.minX).toBeLessThanOrEqual(0);
    expect(result.bounds!.maxX).toBeGreaterThanOrEqual(55);
  });

  it('flags units as unknown when $INSUNITS is absent', () => {
    const result = parseDxf(SAMPLE_DXF);
    expect(result.unitsUnknown).toBe(true);
    expect(result.units).toBe('unknown');
  });

  it('returns no warnings for a file with only supported entity types', () => {
    const result = parseDxf(SAMPLE_DXF);
    expect(result.warnings).toEqual([]);
  });

  it('summarizes skipped unsupported entities instead of one line per entity', () => {
    const withText = SAMPLE_DXF.replace(
      '0\nENDSEC',
      '0\nTEXT\n8\n0\n10\n1.0\n20\n1.0\n30\n0.0\n40\n1.0\n1\nhello\n0\nTEXT\n8\n0\n10\n2.0\n20\n2.0\n30\n0.0\n40\n1.0\n1\nworld\n0\nENDSEC',
    );
    const result = parseDxf(withText);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/2 TEXT entities/);
  });
});
