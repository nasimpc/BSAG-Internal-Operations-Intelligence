import { describe, expect, it } from 'vitest';

import {
  InputError,
  intervalsOverlap,
  parseBerlinRange,
} from '../../src/shared/dates.js';

describe('parseBerlinRange', () => {
  it('uses Europe/Berlin boundaries across DST changes', () => {
    expect(parseBerlinRange('2026-10-25', '2026-10-25').end.toISOString()).toBe(
      '2026-10-25T22:59:59.999Z',
    );
  });

  it('rejects invalid intervals', () => {
    expect(() => parseBerlinRange('2026-10-26', '2026-10-25')).toThrowError(
      InputError,
    );
  });

  it('rejects malformed calendar dates', () => {
    expect(() => parseBerlinRange('2026-02-30', '2026-03-01')).toThrowError(
      InputError,
    );
  });

  it('rejects ranges longer than 31 days', () => {
    expect(() => parseBerlinRange('2026-01-01', '2026-02-02')).toThrowError(
      InputError,
    );
  });
});

describe('intervalsOverlap', () => {
  it('returns true when intervals intersect', () => {
    const a = parseBerlinRange('2026-10-25', '2026-10-25');
    const b = parseBerlinRange('2026-10-25', '2026-10-26');

    expect(intervalsOverlap(a, b)).toBe(true);
  });

  it('returns false when intervals are disjoint', () => {
    const a = parseBerlinRange('2026-10-25', '2026-10-25');
    const b = parseBerlinRange('2026-10-27', '2026-10-27');

    expect(intervalsOverlap(a, b)).toBe(false);
  });
});
