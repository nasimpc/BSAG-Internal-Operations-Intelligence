import { describe, expect, it } from 'vitest';

import { combineOutcomes, envelope, warning } from '../../src/domain/result.js';

describe('result helpers', () => {
  it('marks an envelope complete when there are no warnings', () => {
    expect(
      envelope('2026-06-20T08:00:00.000Z', {
        data: [1],
        sources: [],
        warnings: [],
      }),
    ).toMatchObject({
      generated_at: '2026-06-20T08:00:00.000Z',
      timezone: 'Europe/Berlin',
      status: 'complete',
      data: [1],
    });
  });

  it('combines outcomes into a partial envelope when any source warns', () => {
    const now = '2026-06-20T08:00:00.000Z';

    expect(
      combineOutcomes(
        [
          { data: [1], sources: [], warnings: [] },
          {
            data: [2],
            sources: [],
            warnings: [
              {
                source: 'vmz_web',
                code: 'SOURCE_TIMEOUT',
                message: 'timed out',
                occurred_at: now,
                retryable: true,
              },
            ],
          },
        ],
        now,
      ),
    ).toMatchObject({
      data: [1, 2],
      status: 'partial',
    });
  });

  it('emits machine-readable warning codes', () => {
    expect(
      warning('vmz_web', 'SOURCE_TIMEOUT', 'timed out', {
        occurredAt: '2026-06-20T08:00:00.000Z',
        retryable: true,
      }),
    ).toMatchObject({
      source: 'vmz_web',
      code: 'SOURCE_TIMEOUT',
      message: 'timed out',
      occurred_at: '2026-06-20T08:00:00.000Z',
      retryable: true,
    });
  });
});
