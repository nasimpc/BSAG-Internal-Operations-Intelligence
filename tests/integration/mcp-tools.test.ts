import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { loadCorridors } from '../../src/config/corridors.js';
import type {
  LineHealth,
  ServiceNotice,
  ToolEnvelope,
} from '../../src/domain/models.js';
import type { SourceOutcome } from '../../src/domain/result.js';
import { FixedClock } from '../../src/shared/clock.js';
import { draftPassengerInformation } from '../../src/services/passenger-information.js';
import { assessRisk, DEFAULT_RISK_CONFIG } from '../../src/services/risk.js';
import type {
  GetExternalImpactsInput,
  MatchedExternalImpact,
} from '../../src/services/external-impacts.js';
import type { GetLineHealthInput } from '../../src/services/line-health.js';
import { createOperationsBriefingMcpServer } from '../../src/mcp/server.js';
import type { GetServiceNoticesInput } from '../../src/services/service-notices.js';
import {
  ShiftBriefService,
  type ShiftBrief,
  type ShiftBriefBuildInput,
} from '../../src/services/shift-brief.js';

const TEST_SOURCE_URLS = {
  vbnRealtimeJsonUrl: 'https://feeds.example/vbn.json',
  vbnRealtimeProtobufUrl: 'https://feeds.example/vbn.pb',
  vbnNoticesUrl: 'https://vbn.example/notices',
  bsagNewsUrl: 'https://www.bsag.example/aktuelles',
  vmzCurrentUrl: 'https://vmz.example/current',
  vmzPreviewUrl: 'https://vmz.example/preview',
  vmzOverviewUrl: 'https://vmz.example/overview',
  vmzRssUrl: 'https://vmz.example/feed.rss',
  bremenEventsUrl: 'https://events.example/calendar',
};

interface Harness {
  close(): Promise<void>;
  client: Client;
  calls: {
    externalImpacts: GetExternalImpactsInput[];
    lineHealth: GetLineHealthInput[];
    serviceNotices: GetServiceNoticesInput[];
    shiftBrief: ShiftBriefBuildInput[];
  };
  expectedExternalImpactEnvelope: ToolEnvelope<MatchedExternalImpact[]>;
}

interface HarnessOptions {
  externalImpactsOutcome?: SourceOutcome<MatchedExternalImpact[]>;
  useRealShiftBriefService?: boolean;
}

function textContent(result: unknown): string {
  const content =
    typeof result === 'object' &&
    result !== null &&
    'content' in result &&
    Array.isArray(result.content)
      ? (result.content as unknown[])
      : undefined;

  if (content === undefined) {
    return '';
  }

  return content
    .filter(
      (item): item is { type: 'text'; text: string } =>
        typeof item === 'object' &&
        item !== null &&
        'type' in item &&
        item.type === 'text' &&
        'text' in item &&
        typeof item.text === 'string',
    )
    .map((item) => item.text)
    .join('\n\n');
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = new FixedClock(new Date('2026-06-20T06:00:00.000Z'));
  const calls: Harness['calls'] = {
    externalImpacts: [],
    lineHealth: [],
    serviceNotices: [],
    shiftBrief: [],
  };

  const lineHealthOutcome: SourceOutcome<LineHealth[]> = {
    data: [
      {
        line_id: '10',
        snapshot_at: '2026-06-20T05:59:00.000Z',
        trip_count: 12,
        observed_trip_count: 10,
        coverage_ratio: 10 / 12,
        average_delay_seconds: 360,
        median_delay_seconds: 300,
        p95_delay_seconds: 780,
        max_delay_seconds: 900,
        on_time_percentage: 50,
        warnings: [],
      },
    ],
    sources: [
      {
        source: 'vbn_realtime',
        fetched_at: '2026-06-20T05:59:00.000Z',
        age_seconds: 60,
        stale: false,
      },
    ],
    warnings: [],
  };

  const defaultExternalImpactsOutcome: SourceOutcome<MatchedExternalImpact[]> = {
    data: [
      {
        id: 'vmz-impact-1',
        title: 'Roadworks near Weserpark',
        summary:
          'Lane restrictions may slow buses near Osterholzer Heerstraße.',
        details: 'Osterholzer Heerstraße by Weserpark',
        corridor_ids: ['east'],
        starts_at: '2026-06-21T04:00:00.000Z',
        ends_at: '2026-06-21T14:00:00.000Z',
        category: 'roadworks',
        severity: 'high',
        provenance: {
          source: 'vmz_web',
          sourceUrl: 'https://vmz.example/roadworks',
          fetchedAt: '2026-06-20T05:58:00.000Z',
        },
        corridor_matches: [
          {
            corridor_id: 'east',
            confidence: 'phrase',
            matched_aliases: ['weserpark'],
          },
        ],
      },
    ],
    sources: [
      {
        source: 'vmz_web',
        fetched_at: '2026-06-20T05:58:00.000Z',
        age_seconds: 120,
        stale: false,
      },
    ],
    warnings: [
      {
        source: 'vmz_web',
        code: 'SOURCE_TIMEOUT',
        message: 'VMZ roadworks page timed out; feed-only coverage is in use.',
        occurred_at: '2026-06-20T06:00:00.000Z',
        retryable: true,
      },
    ],
  };

  const externalImpactsOutcome =
    options.externalImpactsOutcome ?? defaultExternalImpactsOutcome;

  const serviceNoticesOutcome: SourceOutcome<ServiceNotice[]> = {
    data: [
      {
        id: 'bsag-1',
        title: 'Stop closure at Domsheide',
        summary: 'Line 10 serves temporary stops during roadworks.',
        lines: ['10'],
        stop_names: ['Domsheide'],
        severity: 'warning',
        provenance: {
          source: 'bsag',
          sourceUrl: 'https://www.bsag.de/aktuelles',
          fetchedAt: '2026-06-20T05:57:00.000Z',
        },
      },
    ],
    sources: [
      {
        source: 'bsag',
        fetched_at: '2026-06-20T05:57:00.000Z',
        age_seconds: 180,
        stale: false,
      },
    ],
    warnings: [],
  };

  const shiftBriefOutcome: SourceOutcome<ShiftBrief> = {
    data: {
      date: '2026-06-21',
      shift_window: {
        start: '2026-06-21T04:00:00.000Z',
        end: '2026-06-21T08:00:00.000Z',
      },
      baseline_at: '2026-06-20T06:00:00.000Z',
      corridor_ids: ['east'],
      candidate_lines: ['10'],
      line_assessments: [
        {
          target_type: 'line',
          target_id: '10',
          score: 72,
          band: 'high',
          contributions: [
            {
              kind: 'delay',
              points: 30,
              reason: 'Line 10 is carrying a 6-minute average delay.',
            },
          ],
          confidence: 'medium',
          warnings: [],
        },
      ],
      corridor_assessments: [
        {
          target_type: 'corridor',
          target_id: 'east',
          score: 72,
          band: 'high',
          contributions: [
            {
              kind: 'overlap',
              points: 15,
              reason:
                'Realtime delay and VMZ roadworks overlap in the corridor.',
            },
          ],
          confidence: 'medium',
          warnings: [],
        },
      ],
      major_events: [],
      overlaps: [
        {
          line_id: '10',
          impact_ids: ['vmz-impact-1'],
          summary: 'Line 10 has realtime delays and VMZ roadworks overlap.',
        },
      ],
      communications: [],
      operational_actions: ['Prepare operational messaging for line 10.'],
    },
    sources: [
      {
        source: 'vbn_realtime',
        fetched_at: '2026-06-20T05:59:00.000Z',
        age_seconds: 60,
        stale: false,
      },
      {
        source: 'vmz_web',
        fetched_at: '2026-06-20T05:58:00.000Z',
        age_seconds: 120,
        stale: false,
      },
    ],
    warnings: [],
  };

  const externalImpactsService = {
    get(input: GetExternalImpactsInput) {
      calls.externalImpacts.push(input);
      return Promise.resolve(externalImpactsOutcome);
    },
  };
  const lineHealthService = {
    get(input: GetLineHealthInput) {
      calls.lineHealth.push(input);
      return Promise.resolve(lineHealthOutcome);
    },
  };
  const serviceNoticesService = {
    get(input: GetServiceNoticesInput) {
      calls.serviceNotices.push(input);
      return Promise.resolve(serviceNoticesOutcome);
    },
  };
  const realShiftBriefService = new ShiftBriefService({
    assessRisk,
    clock,
    corridors: loadCorridors(`${process.cwd()}/config/corridors.json`),
    externalImpactsService,
    lineHealthService,
    passengerInformation: draftPassengerInformation,
    riskConfig: DEFAULT_RISK_CONFIG,
    serviceNoticesService,
  });
  const shiftBriefService =
    options.useRealShiftBriefService === true
      ? {
          build(input: ShiftBriefBuildInput) {
            calls.shiftBrief.push(input);
            return realShiftBriefService.build(input);
          },
        }
      : {
          build(input: ShiftBriefBuildInput) {
            calls.shiftBrief.push(input);
            return Promise.resolve(shiftBriefOutcome);
          },
        };
  const server = createOperationsBriefingMcpServer({
    clock,
    draftPassengerInformation,
    externalImpactsService,
    lineHealthService,
    serviceNoticesService,
    shiftBriefService,
    sourceUrls: TEST_SOURCE_URLS,
  });
  const client = new Client(
    {
      name: 'bsag-mcp-test-client',
      version: '0.0.0',
    },
    {
      capabilities: {},
    },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    async close() {
      await client.close();
      await server.close();
    },
    client,
    calls,
    expectedExternalImpactEnvelope: {
      generated_at: '2026-06-20T06:00:00.000Z',
      timezone: 'Europe/Berlin',
      status: 'partial',
      data: externalImpactsOutcome.data,
      citations: externalImpactsOutcome.data.map((impact, index) => ({
        id: `cite-${String(index + 1)}`,
        source: impact.provenance.source,
        title: impact.title,
        source_url: impact.provenance.sourceUrl,
        fetched_at: impact.provenance.fetchedAt,
        ...(impact.provenance.publishedAt === undefined
          ? {}
          : { published_at: impact.provenance.publishedAt }),
        ...(impact.provenance.contentHash === undefined
          ? {}
          : { content_hash: impact.provenance.contentHash }),
        claim_paths: [`/data/${String(index)}`],
      })),
      sources: externalImpactsOutcome.sources,
      warnings: externalImpactsOutcome.warnings,
    },
  };
}

describe('createOperationsBriefingMcpServer', () => {
  it('lists exactly five tools whose descriptions disclose public-source limits', async () => {
    const harness = await createHarness();

    try {
      const result = await harness.client.listTools();

      expect(result.tools.map((tool) => tool.name)).toEqual([
        'get_line_health',
        'get_external_impacts',
        'get_service_notices',
        'build_shift_brief',
        'draft_passenger_information',
      ]);

      for (const tool of result.tools) {
        expect(tool.description).toMatch(/public/i);
        expect(tool.description).toMatch(/partial|warning|source/i);
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.outputSchema?.type).toBe('object');
      }
    } finally {
      await harness.close();
    }
  });

  it('returns structured results with readable text and deduplicated inputs', async () => {
    const harness = await createHarness();

    try {
      await harness.client.listTools();

      const result = await harness.client.callTool({
        name: 'get_line_health',
        arguments: {
          line_ids: ['10', '10'],
        },
      });

      expect(harness.calls.lineHealth).toEqual([
        {
          line_ids: ['10'],
        },
      ]);
      expect(result.isError).toBeUndefined();
      expect(textContent(result)).toContain('Line health');
      expect(textContent(result)).toContain('Source freshness');
      expect(textContent(result)).toContain('Citations');
      expect(textContent(result)).toContain('```json');
      expect(result.structuredContent).toMatchObject({
        generated_at: '2026-06-20T06:00:00.000Z',
        status: 'complete',
        timezone: 'Europe/Berlin',
        citations: [
          {
            id: 'cite-1',
            source: 'vbn_realtime',
            title: 'VBN GTFS-Realtime',
            source_url: TEST_SOURCE_URLS.vbnRealtimeProtobufUrl,
            alternate_urls: [TEST_SOURCE_URLS.vbnRealtimeJsonUrl],
            fetched_at: '2026-06-20T05:59:00.000Z',
            claim_paths: ['/data/0'],
          },
        ],
      });
    } finally {
      await harness.close();
    }
  });

  it('returns isError for invalid input instead of throwing a protocol exception', async () => {
    const harness = await createHarness();

    try {
      await harness.client.listTools();

      const result = await harness.client.callTool({
        name: 'get_line_health',
        arguments: {
          line_ids: [],
          unexpected: true,
        },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(textContent(result)).toMatch(/input validation error/i);
    } finally {
      await harness.close();
    }
  });

  it('keeps upstream source warnings as a partial success result', async () => {
    const harness = await createHarness();

    try {
      await harness.client.listTools();

      const result = await harness.client.callTool({
        name: 'get_external_impacts',
        arguments: {
          corridors: ['east', 'east'],
          date_from: '2026-06-21',
          date_to: '2026-06-21',
        },
      });

      expect(harness.calls.externalImpacts).toEqual([
        {
          corridors: ['east'],
          date_from: '2026-06-21',
          date_to: '2026-06-21',
        },
      ]);
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual(
        harness.expectedExternalImpactEnvelope,
      );
      expect(textContent(result)).toContain('partial');
      expect(textContent(result)).toContain('SOURCE_TIMEOUT');
      expect(textContent(result)).toContain('VMZ roadworks page timed out');
    } finally {
      await harness.close();
    }
  });

  it('returns a valid shift brief when matched major events include corridor metadata upstream', async () => {
    const harness = await createHarness({
      useRealShiftBriefService: true,
      externalImpactsOutcome: {
        data: [
          {
            id: 'event-impact-1',
            title: 'Weserpark summer concert',
            summary: 'Major event at Weserpark may increase demand.',
            details: 'Weserpark',
            corridor_ids: ['east'],
            starts_at: '2026-06-21T16:00:00.000Z',
            ends_at: '2026-06-21T20:00:00.000Z',
            category: 'event',
            severity: 'moderate',
            provenance: {
              source: 'bremen_events',
              sourceUrl: 'https://events.example/weserpark-concert',
              fetchedAt: '2026-06-20T05:58:00.000Z',
            },
            corridor_matches: [
              {
                corridor_id: 'east',
                confidence: 'phrase',
                matched_aliases: ['weserpark'],
              },
            ],
          },
        ],
        sources: [
          {
            source: 'bremen_events',
            fetched_at: '2026-06-20T05:58:00.000Z',
            age_seconds: 120,
            stale: false,
          },
        ],
        warnings: [],
      },
    });

    try {
      await harness.client.listTools();

      const result = await harness.client.callTool({
        name: 'build_shift_brief',
        arguments: {
          date: '2026-06-21',
          corridors: ['east'],
        },
      });

      expect(harness.calls.shiftBrief).toEqual([
        {
          date: '2026-06-21',
          corridors: ['east'],
        },
      ]);
      expect(harness.calls.externalImpacts).toEqual([
        {
          corridors: ['east'],
          date_from: '2026-06-21',
          date_to: '2026-06-21',
        },
      ]);
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        status: 'complete',
        data: {
          date: '2026-06-21',
          major_events: [
            expect.objectContaining({
              id: 'event-impact-1',
              title: 'Weserpark summer concert',
            }),
          ],
        },
        citations: expect.arrayContaining([
          expect.objectContaining({
            source: 'bremen_events',
            title: 'Weserpark summer concert',
            source_url: 'https://events.example/weserpark-concert',
            claim_paths: ['/data/major_events/0'],
          }),
          expect.objectContaining({
            source: 'vbn_realtime',
            source_url: TEST_SOURCE_URLS.vbnRealtimeProtobufUrl,
            claim_paths: ['/data'],
          }),
        ]),
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain(
        'corridor_matches',
      );
    } finally {
      await harness.close();
    }
  });
});
