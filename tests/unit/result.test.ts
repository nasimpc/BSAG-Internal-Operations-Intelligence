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
      citations: [],
    });
  });

  it('preserves explicit envelope citations', () => {
    expect(
      envelope('2026-06-20T08:00:00.000Z', {
        data: [1],
        citations: [
          {
            id: 'cite-1',
            source: 'vbn_realtime',
            title: 'VBN GTFS-Realtime',
            source_url: 'https://feeds.example/vbn.pb',
            claim_paths: ['/data/0'],
          },
        ],
        sources: [],
        warnings: [],
      }),
    ).toMatchObject({
      citations: [
        {
          id: 'cite-1',
          source: 'vbn_realtime',
          source_url: 'https://feeds.example/vbn.pb',
          claim_paths: ['/data/0'],
        },
      ],
    });
  });

  it('marks an envelope partial when warnings are present', () => {
    expect(
      envelope('2026-06-20T08:00:00.000Z', {
        data: [1],
        sources: [],
        warnings: [
          {
            source: 'vmz_web',
            code: 'SOURCE_TIMEOUT',
            message: 'timed out',
            occurred_at: '2026-06-20T08:00:00.000Z',
            retryable: true,
          },
        ],
      }),
    ).toMatchObject({
      status: 'partial',
    });
  });

  it('combines outcomes into a partial result when any source warns', () => {
    const now = '2026-06-20T08:00:00.000Z';

    expect(
      combineOutcomes([
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
      ]),
    ).toEqual({
      data: [1, 2],
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
      status: 'partial',
    });
  });

  it('combines outcomes into a complete result when there are no warnings', () => {
    expect(
      combineOutcomes([
        { data: [1], sources: [], warnings: [] },
        { data: [2], sources: [], warnings: [] },
      ]),
    ).toEqual({
      data: [1, 2],
      sources: [],
      warnings: [],
      status: 'complete',
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

  it('includes stale cache metadata when provided', () => {
    expect(
      warning('vmz_web', 'SOURCE_TIMEOUT', 'timed out', {
        occurredAt: '2026-06-20T08:00:00.000Z',
        retryable: true,
        staleCacheUsed: true,
        staleAgeSeconds: 300,
      }),
    ).toMatchObject({
      source: 'vmz_web',
      code: 'SOURCE_TIMEOUT',
      message: 'timed out',
      occurred_at: '2026-06-20T08:00:00.000Z',
      retryable: true,
      stale_cache_used: true,
      stale_age_seconds: 300,
    });
  });
});
