import { describe, expect, it } from 'vitest';

import { FixedClock, SystemClock } from '../../src/shared/clock.js';
import { sha256Text } from '../../src/shared/hash.js';

describe('SystemClock', () => {
  it('returns fresh Date instances', () => {
    const clock = new SystemClock();
    const first = clock.now();
    const second = clock.now();

    expect(first).toBeInstanceOf(Date);
    expect(second).toBeInstanceOf(Date);
    expect(first).not.toBe(second);
  });
});

describe('FixedClock', () => {
  it('clones the provided instant and returned dates', () => {
    const source = new Date('2026-06-20T08:00:00.000Z');
    const clock = new FixedClock(source);
    const first = clock.now();

    source.setUTCFullYear(2030);
    first.setUTCMonth(0);

    expect(clock.now().toISOString()).toBe('2026-06-20T08:00:00.000Z');
    expect(first).not.toBe(clock.now());
  });
});

describe('sha256Text', () => {
  it('is stable for canonically equivalent text', () => {
    expect(sha256Text('Café')).toBe(sha256Text('Café'));
  });

  it('normalizes compatibility-equivalent UTF-8 text', () => {
    const hash = sha256Text('ＡＢＣ');

    expect(hash).toBe(sha256Text('ABC'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
  });
});
