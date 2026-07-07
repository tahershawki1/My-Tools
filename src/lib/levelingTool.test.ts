import { describe, it, expect } from 'vitest';
import { calculate, createRow } from './levelingTool';

describe('levelingTool.calculate', () => {
  it('computes HI and elevation for a simple BS/FS run and passes the check', () => {
    const rows = [
      createRow('BM', 1.5, null, null),
      createRow('TP1', null, null, 0.5),
    ];
    const result = calculate(rows, 100);
    expect(result.rows[0].elevation).toBe(100);
    expect(result.rows[0].hi).toBe(101.5);
    expect(result.rows[1].elevation).toBeCloseTo(101, 6);
    expect(result.checkOk).toBe(true);
    expect(result.checkDiff).toBeCloseTo(0, 6);
  });

  it('does not let an intermediate sight (side shot) disturb the closing elevation', () => {
    // BM=100, BS=1.5 -> HI=101.5; IS=2.0 -> side reading 99.5 (must not
    // become the new "current" elevation); FS=0.5 -> closes at 101.0.
    const rows = [
      createRow('BM', 1.5, null, null),
      createRow('IS1', null, 2.0, null),
      createRow('TP1', null, null, 0.5),
    ];
    const result = calculate(rows, 100);
    expect(result.rows.map(r => r.elevation)).toEqual([100, 99.5, 101]);
    expect(result.checkOk).toBe(true);
    expect(result.checkDiff).toBeCloseTo(0, 6);
  });

  it('does not let a trailing intermediate sight after the last foresight fail the check', () => {
    // Regression: an IS taken *after* the closing FS previously moved
    // lastElev, making (sumBS - sumFS) != (last - first) even though the
    // run itself was balanced.
    const rows = [
      createRow('BM', 1.5, null, null),
      createRow('TP1', null, null, 0.5),
      createRow('IS-last', null, 2.0, null),
    ];
    const result = calculate(rows, 100);
    expect(result.checkOk).toBe(true);
    expect(result.checkDiff).toBeCloseTo(0, 6);
  });

  it('flags a row with both IS and FS as an error', () => {
    const rows = [createRow('BM', 1.5, null, null), createRow('X', null, 1.0, 1.0)];
    const result = calculate(rows, 100);
    expect(result.rows[1].error).toMatch(/Cannot enter both/i);
  });

  it('flags IS/FS before any backsight has established a height of instrument', () => {
    const rows = [createRow('X', null, null, 1.0)];
    const result = calculate(rows, 100);
    expect(result.rows[0].error).toMatch(/Height of Instrument/i);
  });
});
