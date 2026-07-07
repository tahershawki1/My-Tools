import { describe, it, expect } from 'vitest';
import { findSnap } from './dxfCanvas';
import type { DxfSegment } from './dxfParser';

// Two segments crossing at (5,5): a horizontal line (0,5)->(10,5) and a
// vertical line (5,0)->(5,10). A query function that just returns everything
// (no spatial index needed for a 2-segment fixture) is enough to exercise the
// pure geometry in findSnap without touching canvas/DOM at all.
const SEGMENTS: DxfSegment[] = [
  { x1: 0, y1: 5, x2: 10, y2: 5, layer: '0' },
  { x1: 5, y1: 0, x2: 5, y2: 10, layer: '0' },
];
const queryAll = () => SEGMENTS;

describe('findSnap', () => {
  it('snaps to the nearest endpoint when the cursor is close to one', () => {
    // Cursor near (0,5), the left end of the horizontal segment.
    const scale = 20; // 20 screen px per world unit
    const result = findSnap(0.1, 5.05, scale, 'endpoint', queryAll);
    expect(result).toEqual({ kind: 'endpoint', x: 0, y: 5 });
  });

  it('snaps to the intersection of two crossing segments', () => {
    const scale = 20;
    const result = findSnap(5.02, 4.98, scale, 'intersection', queryAll);
    expect(result?.kind).toBe('intersection');
    expect(result?.x).toBeCloseTo(5, 5);
    expect(result?.y).toBeCloseTo(5, 5);
  });

  it('prefers the endpoint over an equally-close intersection when mode is "both"', () => {
    // Cursor equidistant-ish from the (10,5) endpoint and no intersection nearby.
    const scale = 20;
    const result = findSnap(9.95, 5.02, scale, 'both', queryAll);
    expect(result).toEqual({ kind: 'endpoint', x: 10, y: 5 });
  });

  it('returns null when nothing is within capture radius', () => {
    const scale = 20;
    const result = findSnap(2, 2, scale, 'both', queryAll); // far from both endpoints and the crossing
    expect(result).toBeNull();
  });

  it('does not snap to a false intersection outside both segments extents', () => {
    // Two segments whose infinite lines cross, but not within their extents.
    const disjoint: DxfSegment[] = [
      { x1: 0, y1: 0, x2: 1, y2: 0, layer: '0' },
      { x1: 5, y1: -1, x2: 5, y2: 1, layer: '0' },
    ];
    const result = findSnap(5, 0, 20, 'intersection', () => disjoint);
    expect(result).toBeNull();
  });
});
