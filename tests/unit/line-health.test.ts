import { describe, expect, it } from 'vitest';

import type { VbnRealtimeRecord } from '../../src/sources/vbn-realtime.js';
import { summarizeLineHealth } from '../../src/services/line-health.js';

function buildRecord(
  routeId: string,
  delaySeconds?: number,
  overrides: Partial<VbnRealtimeRecord> = {},
): VbnRealtimeRecord {
  return {
    route_id: routeId,
    observed_at: '2026-06-20T06:05:00Z',
    has_usable_delay: delaySeconds !== undefined,
    schedule_relationship: 'scheduled',
    update_count: 1,
    ...(delaySeconds === undefined ? {} : { delay_seconds: delaySeconds }),
    ...overrides,
  };
}

describe('summarizeLineHealth', () => {
  it('uses default thresholds and returns clean metrics when coverage is complete', () => {
    const health = summarizeLineHealth('4', '2026-06-20T06:05:00Z', [
      buildRecord('4', 300),
    ]);

    expect(health).toMatchObject({
      line_id: '4',
      snapshot_at: '2026-06-20T06:05:00Z',
      trip_count: 1,
      observed_trip_count: 1,
      coverage_ratio: 1,
      average_delay_seconds: 300,
      median_delay_seconds: 300,
      p95_delay_seconds: 300,
      max_delay_seconds: 300,
      on_time_percentage: 100,
      cancellations: 0,
      skipped_stops: 0,
      warnings: [],
    });
  });

  it('calculates metrics from usable delays only and reports low coverage with cancellations', () => {
    const health = summarizeLineHealth(
      '1',
      '2026-06-20T06:05:00Z',
      [
        buildRecord('1', -120),
        buildRecord('1', 0),
        buildRecord('1', 180),
        buildRecord('1', 420),
        buildRecord('1', undefined, {
          has_usable_delay: false,
          schedule_relationship: 'canceled',
        }),
        buildRecord('1', undefined, {
          has_usable_delay: false,
          schedule_relationship: 'skipped',
        }),
      ],
      {
        earlyRunningThresholdSeconds: 60,
        lowCoverageThreshold: 0.75,
        onTimeThresholdSeconds: 300,
      },
    );

    expect(health).toMatchObject({
      line_id: '1',
      snapshot_at: '2026-06-20T06:05:00Z',
      trip_count: 6,
      observed_trip_count: 4,
      average_delay_seconds: 120,
      median_delay_seconds: 90,
      p95_delay_seconds: 420,
      max_delay_seconds: 420,
      on_time_percentage: 50,
      cancellations: 1,
      skipped_stops: 1,
    });
    expect(health.coverage_ratio).toBeCloseTo(4 / 6, 6);
    expect(health.warnings).toContainEqual(
      expect.objectContaining({
        source: 'vbn_realtime',
        code: 'LOW_DELAY_COVERAGE',
      }),
    );
  });

  it('returns unknown health when a line has zero observations', () => {
    const health = summarizeLineHealth('1', '2026-06-20T06:05:00Z', [], {
      earlyRunningThresholdSeconds: 60,
      lowCoverageThreshold: 0.75,
      onTimeThresholdSeconds: 300,
    });

    expect(health).toMatchObject({
      line_id: '1',
      snapshot_at: '2026-06-20T06:05:00Z',
      trip_count: 0,
      observed_trip_count: 0,
      coverage_ratio: 0,
      average_delay_seconds: 0,
      median_delay_seconds: 0,
      p95_delay_seconds: 0,
      max_delay_seconds: 0,
      on_time_percentage: 0,
      cancellations: 0,
      skipped_stops: 0,
    });
    expect(health.warnings).toContainEqual(
      expect.objectContaining({
        source: 'vbn_realtime',
        code: 'NO_OBSERVATIONS',
      }),
    );
  });
});
