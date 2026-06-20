import { describe, expect, it } from 'vitest';

import { loadCorridors } from '../../src/config/corridors.js';
import type {
  ExternalImpact,
  LineHealth,
  ServiceNotice,
} from '../../src/domain/models.js';
import { type SourceOutcome, warning } from '../../src/domain/result.js';
import { InputError } from '../../src/shared/dates.js';
import { assessRisk, DEFAULT_RISK_CONFIG } from '../../src/services/risk.js';
import type { PassengerInformationDraft } from '../../src/services/passenger-information.js';
import { ShiftBriefService } from '../../src/services/shift-brief.js';

class FixedClock {
  constructor(private readonly value: string) {}

  now(): Date {
    return new Date(this.value);
  }
}

class StubLineHealthService {
  get(): Promise<SourceOutcome<LineHealth[]>> {
    return Promise.resolve({
      data: [
        {
          line_id: '10',
          snapshot_at: '2026-06-19T12:00:00Z',
          trip_count: 8,
          observed_trip_count: 8,
          coverage_ratio: 1,
          average_delay_seconds: 720,
          median_delay_seconds: 660,
          p95_delay_seconds: 900,
          max_delay_seconds: 900,
          on_time_percentage: 25,
          warnings: [],
        },
        {
          line_id: '2',
          snapshot_at: '2026-06-19T12:00:00Z',
          trip_count: 8,
          observed_trip_count: 8,
          coverage_ratio: 1,
          average_delay_seconds: 120,
          median_delay_seconds: 120,
          p95_delay_seconds: 180,
          max_delay_seconds: 180,
          on_time_percentage: 80,
          warnings: [],
        },
      ],
      sources: [
        {
          source: 'vbn_realtime',
          fetched_at: '2026-06-19T12:00:00Z',
          age_seconds: 0,
          stale: false,
        },
      ],
      warnings: [],
    });
  }
}

class StubServiceNoticesService {
  get(): Promise<SourceOutcome<ServiceNotice[]>> {
    return Promise.resolve({
      data: [
        {
          id: 'notice-10',
          title: 'Line 10 diversion',
          summary: 'Diversion may affect line 10',
          lines: ['10'],
          stop_names: ['Peterswerder'],
          severity: 'critical',
          provenance: {
            source: 'bsag',
            sourceUrl: 'https://example.test/notice-10',
            fetchedAt: '2026-06-19T12:00:00Z',
          },
        },
      ],
      sources: [
        {
          source: 'bsag',
          fetched_at: '2026-06-19T12:00:00Z',
          age_seconds: 0,
          stale: false,
        },
      ],
      warnings: [
        warning(
          'bsag',
          'NOTICE_SOURCE_PARTIAL',
          'Some BSAG notices were incomplete',
          {
            occurredAt: '2026-06-19T12:00:00Z',
            retryable: false,
          },
        ),
      ],
    });
  }
}

class StubExternalImpactService {
  get(): Promise<
    SourceOutcome<
      Array<
        ExternalImpact & {
          corridor_matches: Array<{
            corridor_id: string;
            confidence: 'phrase';
            matched_aliases: string[];
          }>;
        }
      >
    >
  > {
    return Promise.resolve({
      data: [
        {
          id: 'impact-roadwork',
          title: 'Steubenstraße — Vollsperrung',
          summary: 'Roadworks may affect Peterswerder',
          details: 'Peterswerder',
          corridor_ids: [],
          starts_at: '2026-06-20T04:00:00.000Z',
          ends_at: '2026-06-20T08:00:00.000Z',
          category: 'roadworks',
          severity: 'high',
          provenance: {
            source: 'vmz_pdf',
            sourceUrl: 'https://example.test/impact-roadwork',
            fetchedAt: '2026-06-19T12:00:00Z',
          },
          corridor_matches: [
            {
              corridor_id: 'east',
              confidence: 'phrase',
              matched_aliases: ['Peterswerder'],
            },
          ],
        },
        {
          id: 'impact-event',
          title: 'Weserpark summer concert',
          summary: 'Major event at Weserpark',
          details: 'Weserpark',
          corridor_ids: [],
          starts_at: '2026-06-20T17:00:00.000Z',
          ends_at: '2026-06-20T20:00:00.000Z',
          category: 'event',
          severity: 'moderate',
          provenance: {
            source: 'bremen_events',
            sourceUrl: 'https://example.test/impact-event',
            fetchedAt: '2026-06-19T12:00:00Z',
          },
          corridor_matches: [
            {
              corridor_id: 'east',
              confidence: 'phrase',
              matched_aliases: ['Weserpark'],
            },
          ],
        },
      ],
      sources: [
        {
          source: 'vmz_pdf',
          fetched_at: '2026-06-19T12:00:00Z',
          age_seconds: 0,
          stale: false,
        },
        {
          source: 'bremen_events',
          fetched_at: '2026-06-19T12:00:00Z',
          age_seconds: 0,
          stale: false,
        },
      ],
      warnings: [],
    });
  }
}

describe('ShiftBriefService', () => {
  it('builds the east-corridor 06:00-10:00 brief with ranked risks, overlap evidence, warnings, and optional comms for high-risk lines only', async () => {
    const draftedMessages: PassengerInformationDraft[] = [];
    const service = new ShiftBriefService({
      assessRisk,
      clock: new FixedClock('2026-06-19T12:00:00Z'),
      corridors: loadCorridors(`${process.cwd()}/config/corridors.json`),
      externalImpactsService: new StubExternalImpactService(),
      lineHealthService: new StubLineHealthService(),
      passengerInformation: (input) => {
        const draft: PassengerInformationDraft = {
          channel: input.channel,
          text: `${input.line_ids.join(', ')}: ${input.issue_summary}`,
          character_count:
            `${input.line_ids.join(', ')}: ${input.issue_summary}`.length,
          manual_edit_required: false,
          warnings: [],
        };
        draftedMessages.push(draft);

        return draft;
      },
      riskConfig: DEFAULT_RISK_CONFIG,
      serviceNoticesService: new StubServiceNoticesService(),
    });

    const outcome = await service.build({
      date: '2026-06-20',
      corridors: ['east'],
      include_comms_draft: true,
    });

    expect(outcome.data.shift_window.start).toBe('2026-06-20T04:00:00.000Z');
    expect(outcome.data.shift_window.end).toBe('2026-06-20T08:00:00.000Z');
    expect(outcome.data.baseline_at).toBe('2026-06-19T12:00:00.000Z');
    expect(outcome.data.candidate_lines).toEqual(
      expect.arrayContaining(['10', '2', '3', '25', '29', '40', '41', '1E']),
    );
    expect(outcome.data.line_assessments[0]?.target_id).toBe('10');
    expect(['high', 'severe']).toContain(
      outcome.data.line_assessments[0]?.band,
    );
    const overlap = outcome.data.overlaps.find(
      (entry) => entry.line_id === '10',
    );
    expect(overlap).toBeDefined();
    expect(overlap?.summary).toContain(
      'realtime delays and VMZ roadworks overlap',
    );
    expect(
      outcome.data.major_events.some(
        (event) => event.title === 'Weserpark summer concert',
      ),
    ).toBe(true);
    expect(outcome.warnings).toContainEqual(
      expect.objectContaining({
        source: 'bsag',
        code: 'NOTICE_SOURCE_PARTIAL',
      }),
    );
    expect(draftedMessages).toHaveLength(1);
    expect(draftedMessages[0]?.text).toContain('10');
  });

  it('defaults to all corridors and omits comms drafts when include_comms_draft is false', async () => {
    const draftedMessages: PassengerInformationDraft[] = [];
    const service = new ShiftBriefService({
      assessRisk,
      clock: new FixedClock('2026-06-19T12:00:00Z'),
      corridors: [
        {
          id: 'custom',
          aliases: ['Custom corridor'],
          line_ids: [],
        },
      ],
      externalImpactsService: new StubExternalImpactService(),
      lineHealthService: new StubLineHealthService(),
      passengerInformation: (input) => {
        const draft: PassengerInformationDraft = {
          channel: input.channel,
          text: `${input.line_ids.join(', ')}: ${input.issue_summary}`,
          character_count:
            `${input.line_ids.join(', ')}: ${input.issue_summary}`.length,
          manual_edit_required: false,
          warnings: [],
        };
        draftedMessages.push(draft);

        return draft;
      },
      riskConfig: DEFAULT_RISK_CONFIG,
      serviceNoticesService: new StubServiceNoticesService(),
    });

    const outcome = await service.build({
      date: '2026-06-20',
    });

    const untouchedCorridor = outcome.data.corridor_assessments.find(
      (assessment) => assessment.target_id === 'custom',
    );

    expect(outcome.data.corridor_ids).toEqual(['custom']);
    expect(outcome.data.communications).toEqual([]);
    expect(draftedMessages).toEqual([]);
    expect(untouchedCorridor).toMatchObject({
      target_id: 'custom',
      band: 'low',
      confidence: 'low',
      contributions: [],
      warnings: [],
    });
  });

  it('rejects unknown corridor IDs', async () => {
    const service = new ShiftBriefService({
      assessRisk,
      clock: new FixedClock('2026-06-19T12:00:00Z'),
      corridors: loadCorridors(`${process.cwd()}/config/corridors.json`),
      externalImpactsService: new StubExternalImpactService(),
      lineHealthService: new StubLineHealthService(),
      passengerInformation: (input) => ({
        channel: input.channel,
        text: input.issue_summary,
        character_count: input.issue_summary.length,
        manual_edit_required: false,
        warnings: [],
      }),
      riskConfig: DEFAULT_RISK_CONFIG,
      serviceNoticesService: new StubServiceNoticesService(),
    });

    await expect(
      service.build({
        date: '2026-06-20',
        corridors: ['unknown'],
      }),
    ).rejects.toBeInstanceOf(InputError);
  });
});
