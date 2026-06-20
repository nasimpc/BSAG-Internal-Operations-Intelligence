import { describe, expect, it } from 'vitest';

import type {
  ExternalImpact,
  LineHealth,
  ServiceNotice,
  SourceStatus,
} from '../../src/domain/models.js';
import {
  assessRisk,
  bandForScore,
  DEFAULT_RISK_CONFIG,
} from '../../src/services/risk.js';

function buildLineHealth(overrides: Partial<LineHealth> = {}): LineHealth {
  return {
    line_id: '10',
    snapshot_at: '2026-06-19T12:00:00Z',
    trip_count: 10,
    observed_trip_count: 10,
    coverage_ratio: 1,
    average_delay_seconds: 0,
    median_delay_seconds: 0,
    p95_delay_seconds: 0,
    max_delay_seconds: 0,
    on_time_percentage: 100,
    warnings: [],
    ...overrides,
  };
}

function buildNotice(overrides: Partial<ServiceNotice> = {}): ServiceNotice {
  return {
    id: 'notice-1',
    title: 'Diversion on line 10',
    summary: 'Diversion may affect line 10',
    lines: ['10'],
    stop_names: ['Peterswerder'],
    severity: 'warning',
    provenance: {
      source: 'bsag',
      sourceUrl: 'https://example.test/notice-1',
      fetchedAt: '2026-06-19T12:00:00Z',
    },
    ...overrides,
  };
}

function buildImpact(overrides: Partial<ExternalImpact> = {}): ExternalImpact {
  return {
    id: 'impact-1',
    title: 'Steubenstraße roadworks',
    summary: 'Roadworks may affect Peterswerder',
    details: 'Peterswerder',
    corridor_ids: ['east'],
    starts_at: '2026-06-20T04:00:00.000Z',
    ends_at: '2026-06-20T08:00:00.000Z',
    category: 'roadworks',
    severity: 'high',
    provenance: {
      source: 'vmz_pdf',
      sourceUrl: 'https://example.test/impact-1',
      fetchedAt: '2026-06-19T12:00:00Z',
    },
    ...overrides,
  };
}

function buildSourceStatus(
  overrides: Partial<SourceStatus> = {},
): SourceStatus {
  return {
    source: 'vbn_realtime',
    stale: false,
    ...overrides,
  };
}

describe('bandForScore', () => {
  it('uses the exact documented band boundaries', () => {
    expect(bandForScore(24)).toBe('low');
    expect(bandForScore(25)).toBe('moderate');
    expect(bandForScore(49)).toBe('moderate');
    expect(bandForScore(50)).toBe('high');
    expect(bandForScore(74)).toBe('high');
    expect(bandForScore(75)).toBe('severe');
  });
});

describe('assessRisk', () => {
  it('scores every contribution kind, caps at 100, and reports reasons', () => {
    const assessment = assessRisk(
      {
        target_type: 'line',
        target_id: '10',
        line_health: buildLineHealth({
          average_delay_seconds: 1_200,
          coverage_ratio: 0.25,
          on_time_percentage: 0,
        }),
        notices: [
          buildNotice({
            severity: 'critical',
          }),
        ],
        impacts: [
          buildImpact({
            severity: 'severe',
          }),
          buildImpact({
            id: 'event-1',
            title: 'Weserpark concert',
            summary: 'Major event at Weserpark',
            category: 'event',
            severity: 'severe',
            provenance: {
              source: 'bremen_events',
              sourceUrl: 'https://example.test/event-1',
              fetchedAt: '2026-06-19T12:00:00Z',
            },
          }),
        ],
        source_statuses: [
          buildSourceStatus({ source: 'vbn_realtime' }),
          buildSourceStatus({ source: 'bsag' }),
          buildSourceStatus({ source: 'vmz_pdf' }),
          buildSourceStatus({ source: 'bremen_events' }),
        ],
        match_quality: 'exact',
      },
      DEFAULT_RISK_CONFIG,
    );

    expect(assessment.score).toBe(100);
    expect(assessment.band).toBe('severe');
    expect(assessment.confidence).toBe('high');
    expect(
      assessment.contributions.find((item) => item.kind === 'delay')?.points,
    ).toBe(30);
    expect(
      assessment.contributions.find((item) => item.kind === 'on_time')?.points,
    ).toBe(15);
    expect(
      assessment.contributions.find((item) => item.kind === 'coverage')?.points,
    ).toBe(5);
    expect(
      assessment.contributions.find((item) => item.kind === 'notice')?.points,
    ).toBe(25);
    expect(
      assessment.contributions.find((item) => item.kind === 'roadwork')?.points,
    ).toBe(20);
    expect(
      assessment.contributions.find((item) => item.kind === 'event')?.points,
    ).toBe(10);
    expect(
      assessment.contributions.find((item) => item.kind === 'overlap')?.points,
    ).toBe(10);
    expect(typeof assessment.contributions[0]?.kind).toBe('string');
    expect(typeof assessment.contributions[0]?.points).toBe('number');
    expect(typeof assessment.contributions[0]?.reason).toBe('string');
  });

  it('treats zero observations as unknown and lowers confidence when sources are stale or only phrase-matched', () => {
    const assessment = assessRisk(
      {
        target_type: 'corridor',
        target_id: 'east',
        line_health: buildLineHealth({
          trip_count: 0,
          observed_trip_count: 0,
          coverage_ratio: 0,
          average_delay_seconds: 0,
          on_time_percentage: 0,
        }),
        notices: [],
        impacts: [],
        source_statuses: [
          buildSourceStatus({ source: 'vbn_realtime', stale: true }),
          buildSourceStatus({ source: 'bsag', stale: true }),
        ],
        match_quality: 'phrase',
      },
      DEFAULT_RISK_CONFIG,
    );

    expect(assessment.score).toBe(0);
    expect(assessment.band).toBe('low');
    expect(assessment.confidence).toBe('low');
    expect(
      assessment.contributions.some(
        (contribution) => contribution.kind === 'delay',
      ),
    ).toBe(false);
    expect(assessment.warnings).toContainEqual(
      expect.objectContaining({
        code: 'MISSING_SOURCE_FRESHNESS',
      }),
    );
  });
});
