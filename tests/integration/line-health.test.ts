import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SourceOutcome } from '../../src/domain/result.js';
import { openDatabase } from '../../src/storage/database.js';
import { createRepositories } from '../../src/storage/repositories.js';
import type { VbnRealtimeRecord } from '../../src/sources/vbn-realtime.js';
import { LineHealthService } from '../../src/services/line-health.js';

interface MutableClock {
  now(): Date;
  set(value: string): void;
}

interface Harness {
  close(): void;
  repositories: ReturnType<typeof createRepositories>;
}

class TestClock implements MutableClock {
  #value: Date;

  constructor(value: string) {
    this.#value = new Date(value);
  }

  now(): Date {
    return new Date(this.#value);
  }

  set(value: string): void {
    this.#value = new Date(value);
  }
}

class StubRealtimeSource {
  readonly #outcomes: SourceOutcome<VbnRealtimeRecord[]>[];
  readonly #latencyMs: number;
  callCount = 0;

  constructor(
    outcomes: SourceOutcome<VbnRealtimeRecord[]>[],
    options: { latencyMs?: number } = {},
  ) {
    this.#outcomes = [...outcomes];
    this.#latencyMs = options.latencyMs ?? 0;
  }

  async fetch(): Promise<SourceOutcome<VbnRealtimeRecord[]>> {
    this.callCount += 1;

    if (this.#latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#latencyMs));
    }

    return (
      this.#outcomes.shift() ?? {
        data: [],
        sources: [
          {
            source: 'vbn_realtime',
            fetched_at: '2026-06-20T06:05:00Z',
            age_seconds: 0,
            stale: false,
          },
        ],
        warnings: [],
      }
    );
  }
}

function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'bsag-line-health-'));
  const handle = openDatabase(join(dir, 'storage.sqlite'));
  const repositories = createRepositories(handle);

  return {
    repositories,
    close(): void {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function buildOutcome(
  observedAt: string,
  records: VbnRealtimeRecord[],
): SourceOutcome<VbnRealtimeRecord[]> {
  return {
    data: records.map((record) => ({
      ...record,
      observed_at: observedAt,
    })),
    sources: [
      {
        source: 'vbn_realtime',
        fetched_at: observedAt,
        age_seconds: 0,
        stale: false,
      },
    ],
    warnings: [],
  };
}

describe('LineHealthService', () => {
  it('coalesces concurrent refreshes and deduplicates requested line IDs', async () => {
    const harness = createHarness();
    const clock = new TestClock('2026-06-20T06:05:00Z');
    const source = new StubRealtimeSource(
      [
        buildOutcome('2026-06-20T06:05:00Z', [
          {
            route_id: '1',
            trip_id: 'trip-1',
            observed_at: '2026-06-20T06:05:00Z',
            delay_seconds: 180,
            has_usable_delay: true,
            schedule_relationship: 'scheduled',
            update_count: 1,
          },
        ]),
      ],
      { latencyMs: 10 },
    );
    const service = new LineHealthService({
      clock,
      repositories: harness.repositories,
      retentionDays: 30,
      refreshIntervalSeconds: 60,
      source,
    });

    try {
      const [first, second] = await Promise.all([
        service.get({ line_ids: ['1'] }),
        service.get({ line_ids: ['1', '1'] }),
      ]);

      expect(source.callCount).toBe(1);
      expect(first.data).toHaveLength(1);
      expect(second.data).toHaveLength(1);
      expect(first.data[0]?.line_id).toBe('1');
      expect(second.data[0]?.line_id).toBe('1');
    } finally {
      harness.close();
    }
  });

  it('selects historical snapshots at or before the requested time and stops after 15 minutes', async () => {
    const harness = createHarness();
    const clock = new TestClock('2026-06-20T06:05:00Z');
    const source = new StubRealtimeSource([
      buildOutcome('2026-06-20T06:05:00Z', [
        {
          route_id: '1',
          trip_id: 'trip-1',
          observed_at: '2026-06-20T06:05:00Z',
          delay_seconds: 420,
          has_usable_delay: true,
          schedule_relationship: 'scheduled',
          update_count: 1,
        },
      ]),
    ]);
    const service = new LineHealthService({
      clock,
      repositories: harness.repositories,
      retentionDays: 30,
      refreshIntervalSeconds: 60,
      source,
    });

    try {
      await service.get({ line_ids: ['1'] });

      const historical = await service.get({
        line_ids: ['1'],
        at_time: '2026-06-20T06:07:00Z',
      });
      const expired = await service.get({
        line_ids: ['1'],
        at_time: '2026-06-20T07:00:00Z',
      });

      expect(source.callCount).toBe(1);
      expect(historical.data[0]).toMatchObject({
        line_id: '1',
        snapshot_at: '2026-06-20T06:05:00Z',
        max_delay_seconds: 420,
      });
      expect(expired.data[0]).toMatchObject({
        line_id: '1',
        snapshot_at: '2026-06-20T07:00:00Z',
        trip_count: 0,
      });
      expect(expired.data[0]?.warnings).toContainEqual(
        expect.objectContaining({
          source: 'vbn_realtime',
          code: 'NO_OBSERVATIONS',
        }),
      );
    } finally {
      harness.close();
    }
  });

  it('rejects requests with more than 100 line IDs', async () => {
    const harness = createHarness();
    const clock = new TestClock('2026-06-20T06:05:00Z');
    const source = new StubRealtimeSource([]);
    const service = new LineHealthService({
      clock,
      repositories: harness.repositories,
      retentionDays: 30,
      refreshIntervalSeconds: 60,
      source,
    });

    try {
      await expect(
        service.get({
          line_ids: Array.from({ length: 101 }, (_, index) =>
            String(index + 1),
          ),
        }),
      ).rejects.toThrow(/100/i);
    } finally {
      harness.close();
    }
  });

  it('uses cached snapshots within the refresh interval and preserves non-usable stored delays', async () => {
    const harness = createHarness();
    const clock = new TestClock('2026-06-20T06:05:00Z');
    const source = new StubRealtimeSource([
      buildOutcome('2026-06-20T06:05:00Z', [
        {
          route_id: '4',
          trip_id: 'trip-4',
          observed_at: '2026-06-20T06:05:00Z',
          delay_seconds: 180,
          has_usable_delay: false,
          schedule_relationship: 'scheduled',
          update_count: 1,
        },
      ]),
    ]);
    const service = new LineHealthService({
      clock,
      repositories: harness.repositories,
      retentionDays: 30,
      refreshIntervalSeconds: 300,
      source,
    });

    try {
      const first = await service.get({ line_ids: ['4'] });

      clock.set('2026-06-20T06:06:00Z');

      const second = await service.get({ line_ids: ['4'] });

      expect(source.callCount).toBe(1);
      expect(first.data[0]).toMatchObject({
        line_id: '4',
        trip_count: 1,
        observed_trip_count: 0,
        coverage_ratio: 0,
      });
      expect(second.sources).toEqual([
        expect.objectContaining({
          source: 'vbn_realtime',
          stale: false,
          fetched_at: '2026-06-20T06:05:00.000Z',
          age_seconds: 60,
        }),
      ]);
      expect(second.warnings).toContainEqual(
        expect.objectContaining({
          source: 'vbn_realtime',
          code: 'NO_USABLE_DELAYS',
        }),
      );
    } finally {
      harness.close();
    }
  });

  it('uses the request time as the snapshot when a refresh returns no observations', async () => {
    const harness = createHarness();
    const clock = new TestClock('2026-06-20T06:05:00Z');
    const source = new StubRealtimeSource([
      {
        data: [],
        sources: [
          {
            source: 'vbn_realtime',
            fetched_at: '2026-06-20T06:05:00Z',
            age_seconds: 0,
            stale: false,
          },
        ],
        warnings: [],
      },
    ]);
    const service = new LineHealthService({
      clock,
      repositories: harness.repositories,
      retentionDays: 30,
      refreshIntervalSeconds: 300,
      source,
    });

    try {
      const result = await service.get({ line_ids: ['7'] });

      expect(source.callCount).toBe(1);
      expect(result.data[0]).toMatchObject({
        line_id: '7',
        snapshot_at: '2026-06-20T06:05:00.000Z',
        trip_count: 0,
      });
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          source: 'vbn_realtime',
          code: 'NO_OBSERVATIONS',
        }),
      );
    } finally {
      harness.close();
    }
  });

  it('rejects empty line ID requests and rethrows refresh failures when no cache exists', async () => {
    const harness = createHarness();
    const clock = new TestClock('2026-06-20T06:05:00Z');
    const service = new LineHealthService({
      clock,
      repositories: harness.repositories,
      retentionDays: 30,
      refreshIntervalSeconds: 60,
      source: {
        fetch: () => Promise.reject(new Error('realtime unavailable')),
      },
    });

    try {
      await expect(
        service.get({
          line_ids: ['   ', ''],
        }),
      ).rejects.toThrow(/at least one non-empty line ID/i);
      await expect(
        service.get({
          line_ids: ['1'],
        }),
      ).rejects.toThrow(/realtime unavailable/i);
    } finally {
      harness.close();
    }
  });
});
