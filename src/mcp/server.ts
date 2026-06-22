import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type {
  Citation,
  LineHealth,
  Provenance,
  ServiceNotice,
  SourceId,
  SourceStatus,
  ToolEnvelope,
} from '../domain/models.js';
import { envelope, type SourceOutcome } from '../domain/result.js';
import type { Clock } from '../shared/clock.js';
import { InputError } from '../shared/dates.js';
import type {
  MatchedExternalImpact,
  GetExternalImpactsInput,
} from '../services/external-impacts.js';
import type { GetLineHealthInput } from '../services/line-health.js';
import type {
  DraftPassengerInformationInput,
  PassengerInformationDraft,
} from '../services/passenger-information.js';
import type { GetServiceNoticesInput } from '../services/service-notices.js';
import type {
  ShiftBrief,
  ShiftBriefBuildInput,
} from '../services/shift-brief.js';
import { SERVER_INFO } from '../version.js';
import { presentToolEnvelope } from './presenter.js';

const sourceIdSchema = z.enum([
  'vbn_realtime',
  'vbn_notices',
  'bsag',
  'vmz_rss',
  'vmz_web',
  'vmz_pdf',
  'bremen_events',
]);

const isoDateSchema = z.iso.date();
const isoDateTimeSchema = z.iso.datetime({ offset: true });
const nonEmptyStringSchema = z.string().trim().min(1);
const lineIdListSchema = z
  .array(nonEmptyStringSchema)
  .min(1)
  .max(100)
  .transform(dedupeStrings);
const corridorListSchema = z
  .array(nonEmptyStringSchema)
  .min(1)
  .max(20)
  .transform(dedupeStrings);
const stopNameListSchema = z
  .array(nonEmptyStringSchema)
  .min(1)
  .max(50)
  .transform(dedupeStrings);

const provenanceSchema = z
  .object({
    source: sourceIdSchema,
    sourceUrl: z.url(),
    fetchedAt: isoDateTimeSchema,
    publishedAt: isoDateTimeSchema.optional(),
    contentHash: z.string().min(1).optional(),
  })
  .strict();

const citationSchema = z
  .object({
    id: z.string().min(1),
    source: sourceIdSchema,
    title: z.string().min(1),
    source_url: z.url(),
    alternate_urls: z.array(z.url()).min(1).optional(),
    fetched_at: isoDateTimeSchema.optional(),
    published_at: isoDateTimeSchema.optional(),
    content_hash: z.string().min(1).optional(),
    claim_paths: z.array(z.string().min(1)),
  })
  .strict();

const sourceStatusSchema = z
  .object({
    source: sourceIdSchema,
    fetched_at: isoDateTimeSchema.optional(),
    age_seconds: z.number().int().nonnegative().optional(),
    stale: z.boolean(),
  })
  .strict();

const sourceWarningSchema = z
  .object({
    source: sourceIdSchema,
    code: z.string().min(1),
    message: z.string().min(1),
    occurred_at: isoDateTimeSchema,
    retryable: z.boolean(),
    stale_cache_used: z.boolean().optional(),
    stale_age_seconds: z.number().int().nonnegative().optional(),
  })
  .strict();

const lineHealthSchema = z
  .object({
    line_id: z.string().min(1),
    snapshot_at: isoDateTimeSchema,
    trip_count: z.number().int().nonnegative(),
    observed_trip_count: z.number().int().nonnegative(),
    coverage_ratio: z.number(),
    average_delay_seconds: z.number(),
    median_delay_seconds: z.number(),
    p95_delay_seconds: z.number(),
    max_delay_seconds: z.number(),
    on_time_percentage: z.number(),
    cancellations: z.number().int().nonnegative().optional(),
    skipped_stops: z.number().int().nonnegative().optional(),
    warnings: z.array(sourceWarningSchema),
  })
  .strict();

const serviceNoticeSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
    details: z.string().min(1).optional(),
    lines: z.array(z.string().min(1)),
    stop_names: z.array(z.string().min(1)),
    valid_from: isoDateTimeSchema.optional(),
    valid_to: isoDateTimeSchema.optional(),
    severity: z.enum(['info', 'warning', 'critical']),
    provenance: provenanceSchema,
  })
  .strict();

const externalImpactSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
    details: z.string().min(1).optional(),
    corridor_ids: z.array(z.string().min(1)),
    starts_at: isoDateTimeSchema.optional(),
    ends_at: isoDateTimeSchema.optional(),
    category: z.enum(['roadworks', 'event', 'incident', 'other']),
    severity: z.enum(['low', 'moderate', 'high', 'severe']),
    provenance: provenanceSchema,
  })
  .strict();

const matchedExternalImpactSchema = externalImpactSchema
  .extend({
    corridor_matches: z.array(
      z
        .object({
          corridor_id: z.string().min(1),
          confidence: z.enum(['exact', 'phrase']),
          matched_aliases: z.array(z.string().min(1)),
        })
        .strict(),
    ),
  })
  .strict();

const riskContributionSchema = z
  .object({
    kind: z.enum([
      'delay',
      'on_time',
      'coverage',
      'notice',
      'roadwork',
      'event',
      'overlap',
    ]),
    points: z.number(),
    reason: z.string().min(1),
  })
  .strict();

const riskWarningSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

const riskAssessmentSchema = z
  .object({
    target_type: z.enum(['line', 'corridor']),
    target_id: z.string().min(1),
    score: z.number(),
    band: z.enum(['low', 'moderate', 'high', 'severe']),
    contributions: z.array(riskContributionSchema),
    confidence: z.enum(['low', 'medium', 'high']),
    warnings: z.array(riskWarningSchema),
  })
  .strict();

const passengerInformationWarningSchema = z
  .object({
    code: z.enum(['SUMMARY_TRUNCATED', 'MANUAL_EDIT_REQUIRED']),
    message: z.string().min(1),
  })
  .strict();

const passengerInformationDraftSchema = z
  .object({
    channel: z.enum(['app', 'web', 'stop']),
    text: z.string().min(1),
    character_count: z.number().int().nonnegative(),
    manual_edit_required: z.boolean(),
    warnings: z.array(passengerInformationWarningSchema),
  })
  .strict();

const shiftBriefSchema = z
  .object({
    date: isoDateSchema,
    shift_window: z
      .object({
        start: isoDateTimeSchema,
        end: isoDateTimeSchema,
      })
      .strict(),
    baseline_at: isoDateTimeSchema,
    corridor_ids: z.array(z.string().min(1)),
    candidate_lines: z.array(z.string().min(1)),
    line_assessments: z.array(riskAssessmentSchema),
    corridor_assessments: z.array(riskAssessmentSchema),
    major_events: z.array(externalImpactSchema),
    overlaps: z.array(
      z
        .object({
          line_id: z.string().min(1),
          impact_ids: z.array(z.string().min(1)),
          summary: z.string().min(1),
        })
        .strict(),
    ),
    communications: z.array(passengerInformationDraftSchema),
    operational_actions: z.array(z.string().min(1)),
  })
  .strict();

function toolEnvelopeSchema<T extends z.ZodType>(dataSchema: T) {
  return z
    .object({
      generated_at: isoDateTimeSchema,
      timezone: z.literal('Europe/Berlin'),
      status: z.enum(['complete', 'partial']),
      data: dataSchema,
      citations: z.array(citationSchema),
      sources: z.array(sourceStatusSchema),
      warnings: z.array(sourceWarningSchema),
    })
    .strict();
}

const getLineHealthInputSchema = z
  .object({
    line_ids: lineIdListSchema,
    at_time: isoDateTimeSchema.optional(),
  })
  .strict();

const getExternalImpactsInputSchema = z
  .object({
    corridors: corridorListSchema.optional(),
    date_from: isoDateSchema,
    date_to: isoDateSchema,
  })
  .strict();

const getServiceNoticesInputSchema = z
  .object({
    line_ids: lineIdListSchema.optional(),
    stop_names: stopNameListSchema.optional(),
    since: isoDateTimeSchema.optional(),
  })
  .strict();

const buildShiftBriefInputSchema = z
  .object({
    date: isoDateSchema,
    corridors: corridorListSchema.optional(),
    include_comms_draft: z.boolean().optional(),
  })
  .strict();

const draftPassengerInformationInputSchema = z
  .object({
    line_ids: z
      .array(nonEmptyStringSchema)
      .min(1)
      .max(50)
      .transform(dedupeStrings),
    issue_summary: z.string().trim().min(1).max(2_000),
    channel: z.enum(['app', 'web', 'stop']),
  })
  .strict();

const getLineHealthOutputSchema = toolEnvelopeSchema(z.array(lineHealthSchema));
const getExternalImpactsOutputSchema = toolEnvelopeSchema(
  z.array(matchedExternalImpactSchema),
);
const getServiceNoticesOutputSchema = toolEnvelopeSchema(
  z.array(serviceNoticeSchema),
);
const buildShiftBriefOutputSchema = toolEnvelopeSchema(shiftBriefSchema);
const draftPassengerInformationOutputSchema = toolEnvelopeSchema(
  passengerInformationDraftSchema,
);

export interface OperationsBriefingSourceUrls {
  vbnRealtimeJsonUrl: string;
  vbnRealtimeProtobufUrl: string;
  vbnNoticesUrl: string;
  bsagNewsUrl: string;
  vmzCurrentUrl: string;
  vmzPreviewUrl: string;
  vmzOverviewUrl: string;
  vmzRssUrl: string;
  bremenEventsUrl: string;
}

export interface OperationsBriefingMcpServerOptions {
  clock: Clock;
  draftPassengerInformation(
    input: DraftPassengerInformationInput,
  ): PassengerInformationDraft;
  externalImpactsService: {
    get(
      input: GetExternalImpactsInput,
    ): Promise<SourceOutcome<MatchedExternalImpact[]>>;
  };
  lineHealthService: {
    get(input: GetLineHealthInput): Promise<SourceOutcome<LineHealth[]>>;
  };
  serviceNoticesService: {
    get(input: GetServiceNoticesInput): Promise<SourceOutcome<ServiceNotice[]>>;
  };
  shiftBriefService: {
    build(input: ShiftBriefBuildInput): Promise<SourceOutcome<ShiftBrief>>;
  };
  sourceUrls: OperationsBriefingSourceUrls;
}

export function createOperationsBriefingMcpServer(
  options: OperationsBriefingMcpServerOptions,
): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    'get_line_health',
    {
      description:
        'Get public-source VBN GTFS-Realtime health for one or more BSAG/VBN line labels or GTFS route IDs. Standard public labels such as 6 or 10 are translated through the configured route map; unmapped labels return explicit source warnings such as ROUTE_MAPPING_UNAVAILABLE.',
      inputSchema: getLineHealthInputSchema,
      outputSchema: getLineHealthOutputSchema,
    },
    async (input) => {
      try {
        const serviceInput = toLineHealthInput(input);
        const outcome = await options.lineHealthService.get(serviceInput);

        return presentToolEnvelope({
          title: 'Line health',
          summary: summarizeLineHealth(serviceInput, outcome),
          envelope: buildEnvelope(
            options.clock,
            outcome,
            buildLineHealthCitations(outcome, options.sourceUrls),
          ),
        });
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    'get_external_impacts',
    {
      description:
        'List public-source roadworks, detours, and events affecting BSAG corridors. Results may be partial and include explicit source warnings when VMZ or event sources are incomplete.',
      inputSchema: getExternalImpactsInputSchema,
      outputSchema: getExternalImpactsOutputSchema,
    },
    async (input) => {
      try {
        const serviceInput = toExternalImpactsInput(input);
        const outcome = await options.externalImpactsService.get(serviceInput);

        return presentToolEnvelope({
          title: 'External impacts',
          summary: summarizeExternalImpacts(serviceInput, outcome),
          envelope: buildEnvelope(
            options.clock,
            outcome,
            buildItemProvenanceCitations(outcome.data, (index) =>
              dataPath(index),
            ),
          ),
        });
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    'get_service_notices',
    {
      description:
        'Collect public-source BSAG and VBN service notices for lines or stops. Results may be partial and include explicit source warnings when notice pages cannot be refreshed.',
      inputSchema: getServiceNoticesInputSchema,
      outputSchema: getServiceNoticesOutputSchema,
    },
    async (input) => {
      try {
        const serviceInput = toServiceNoticesInput(input);
        const outcome = await options.serviceNoticesService.get(serviceInput);

        return presentToolEnvelope({
          title: 'Service notices',
          summary: summarizeServiceNotices(serviceInput, outcome),
          envelope: buildEnvelope(
            options.clock,
            outcome,
            buildItemProvenanceCitations(outcome.data, (index) =>
              dataPath(index),
            ),
          ),
        });
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    'build_shift_brief',
    {
      description:
        'Build a public-source BSAG operations shift brief for the requested date and corridors. Results may be partial and include explicit source warnings when underlying feeds are incomplete.',
      inputSchema: buildShiftBriefInputSchema,
      outputSchema: buildShiftBriefOutputSchema,
    },
    async (input) => {
      try {
        const serviceInput = toShiftBriefInput(input);
        const outcome = await options.shiftBriefService.build(serviceInput);

        return presentToolEnvelope({
          title: 'Shift brief',
          summary: summarizeShiftBrief(serviceInput, outcome),
          envelope: buildEnvelope(
            options.clock,
            outcome,
            buildShiftBriefCitations(outcome, options.sourceUrls),
          ),
        });
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    'draft_passenger_information',
    {
      description:
        'Draft passenger-facing copy from public-source operations findings. Output is deterministic text and can still include manual-edit warnings when channel limits are tight.',
      inputSchema: draftPassengerInformationInputSchema,
      outputSchema: draftPassengerInformationOutputSchema,
    },
    (input) => {
      try {
        const draft = options.draftPassengerInformation(input);
        const outcome: SourceOutcome<PassengerInformationDraft> = {
          data: draft,
          sources: [],
          warnings: [],
        };

        return presentToolEnvelope({
          title: 'Passenger information draft',
          summary: summarizePassengerInformationDraft(input, draft),
          envelope: buildEnvelope(options.clock, outcome),
        });
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  return server;
}

function toLineHealthInput(
  input: z.output<typeof getLineHealthInputSchema>,
): GetLineHealthInput {
  return {
    line_ids: input.line_ids,
    ...(input.at_time === undefined ? {} : { at_time: input.at_time }),
  };
}

function toExternalImpactsInput(
  input: z.output<typeof getExternalImpactsInputSchema>,
): GetExternalImpactsInput {
  return {
    date_from: input.date_from,
    date_to: input.date_to,
    ...(input.corridors === undefined ? {} : { corridors: input.corridors }),
  };
}

function toServiceNoticesInput(
  input: z.output<typeof getServiceNoticesInputSchema>,
): GetServiceNoticesInput {
  return {
    ...(input.line_ids === undefined ? {} : { line_ids: input.line_ids }),
    ...(input.stop_names === undefined ? {} : { stop_names: input.stop_names }),
    ...(input.since === undefined ? {} : { since: input.since }),
  };
}

function toShiftBriefInput(
  input: z.output<typeof buildShiftBriefInputSchema>,
): ShiftBriefBuildInput {
  return {
    date: input.date,
    ...(input.corridors === undefined ? {} : { corridors: input.corridors }),
    ...(input.include_comms_draft === undefined
      ? {}
      : { include_comms_draft: input.include_comms_draft }),
  };
}

function buildEnvelope<T>(
  clock: Clock,
  outcome: SourceOutcome<T>,
  citations: Citation[] = outcome.citations ?? [],
): ToolEnvelope<T> {
  return envelope(clock.now().toISOString(), {
    ...outcome,
    citations,
  });
}

type CitationDraft = Omit<Citation, 'id'>;

function buildLineHealthCitations(
  outcome: SourceOutcome<LineHealth[]>,
  sourceUrls: OperationsBriefingSourceUrls,
): Citation[] {
  const status = outcome.sources.find(
    (sourceStatus) => sourceStatus.source === 'vbn_realtime',
  );
  const citation = catalogCitationDraft(
    'vbn_realtime',
    sourceUrls,
    claimPathsForData(outcome.data),
    status,
  );

  return citation === undefined ? [] : finalizeCitations([citation]);
}

function buildItemProvenanceCitations<
  T extends { title: string; provenance: Provenance },
>(items: readonly T[], claimPath: (index: number) => string): Citation[] {
  return finalizeCitations(
    items.map((item, index) =>
      provenanceCitationDraft(item.provenance, item.title, [claimPath(index)]),
    ),
  );
}

function buildShiftBriefCitations(
  outcome: SourceOutcome<ShiftBrief>,
  sourceUrls: OperationsBriefingSourceUrls,
): Citation[] {
  return finalizeCitations([
    ...outcome.data.major_events.map((event, index) =>
      provenanceCitationDraft(event.provenance, event.title, [
        `/data/major_events/${String(index)}`,
      ]),
    ),
    ...sourceStatusCitationDrafts(outcome.sources, sourceUrls, ['/data']),
  ]);
}

function sourceStatusCitationDrafts(
  statuses: readonly SourceStatus[],
  sourceUrls: OperationsBriefingSourceUrls,
  claimPaths: string[],
): CitationDraft[] {
  const citations: CitationDraft[] = [];
  const seen = new Set<SourceId>();

  for (const status of statuses) {
    if (seen.has(status.source)) {
      continue;
    }

    seen.add(status.source);

    const citation = catalogCitationDraft(
      status.source,
      sourceUrls,
      claimPaths,
      status,
    );

    if (citation !== undefined) {
      citations.push(citation);
    }
  }

  return citations;
}

function catalogCitationDraft(
  source: SourceId,
  sourceUrls: OperationsBriefingSourceUrls,
  claimPaths: string[],
  status?: SourceStatus,
): CitationDraft | undefined {
  const entry = catalogEntryForSource(source, sourceUrls);

  if (entry === undefined) {
    return undefined;
  }

  return {
    source,
    title: entry.title,
    source_url: entry.source_url,
    ...(entry.alternate_urls === undefined
      ? {}
      : { alternate_urls: entry.alternate_urls }),
    ...(status?.fetched_at === undefined
      ? {}
      : { fetched_at: status.fetched_at }),
    claim_paths: claimPaths,
  };
}

function catalogEntryForSource(
  source: SourceId,
  sourceUrls: OperationsBriefingSourceUrls,
):
  | {
      title: string;
      source_url: string;
      alternate_urls?: string[];
    }
  | undefined {
  switch (source) {
    case 'vbn_realtime':
      return {
        title: 'VBN GTFS-Realtime',
        source_url: sourceUrls.vbnRealtimeProtobufUrl,
        ...alternateUrls([sourceUrls.vbnRealtimeJsonUrl]),
      };
    case 'vbn_notices':
      return {
        title: 'VBN service notices',
        source_url: sourceUrls.vbnNoticesUrl,
      };
    case 'bsag':
      return {
        title: 'BSAG Aktuelles',
        source_url: sourceUrls.bsagNewsUrl,
      };
    case 'vmz_rss':
      return {
        title: 'VMZ Bremen traffic RSS',
        source_url: sourceUrls.vmzRssUrl,
      };
    case 'vmz_web':
      return {
        title: 'VMZ Bremen roadworks',
        source_url: sourceUrls.vmzCurrentUrl,
        ...alternateUrls([
          sourceUrls.vmzPreviewUrl,
          sourceUrls.vmzOverviewUrl,
        ]),
      };
    case 'vmz_pdf':
      return {
        title: 'VMZ Bremen roadworks PDFs',
        source_url: sourceUrls.vmzOverviewUrl,
        ...alternateUrls([
          sourceUrls.vmzCurrentUrl,
          sourceUrls.vmzPreviewUrl,
        ]),
      };
    case 'bremen_events':
      return {
        title: 'Bremen event listings',
        source_url: sourceUrls.bremenEventsUrl,
      };
  }
}

function provenanceCitationDraft(
  provenance: Provenance,
  title: string,
  claimPaths: string[],
): CitationDraft {
  return {
    source: provenance.source,
    title,
    source_url: provenance.sourceUrl,
    fetched_at: provenance.fetchedAt,
    ...(provenance.publishedAt === undefined
      ? {}
      : { published_at: provenance.publishedAt }),
    ...(provenance.contentHash === undefined
      ? {}
      : { content_hash: provenance.contentHash }),
    claim_paths: claimPaths,
  };
}

function finalizeCitations(citations: CitationDraft[]): Citation[] {
  return citations.map((citation, index) => ({
    id: `cite-${String(index + 1)}`,
    ...citation,
  }));
}

function claimPathsForData(data: readonly unknown[]): string[] {
  return data.length === 0
    ? ['/data']
    : data.map((_, index) => dataPath(index));
}

function dataPath(index: number): string {
  return `/data/${String(index)}`;
}

function dedupeUrls(urls: readonly string[]): string[] | undefined {
  const deduped = [...new Set(urls.filter((url) => url.length > 0))];

  return deduped.length === 0 ? undefined : deduped;
}

function alternateUrls(
  urls: readonly string[],
): { alternate_urls: string[] } | Record<string, never> {
  const deduped = dedupeUrls(urls);

  return deduped === undefined ? {} : { alternate_urls: deduped };
}

function summarizeLineHealth(
  input: GetLineHealthInput,
  outcome: SourceOutcome<LineHealth[]>,
): string[] {
  const observedLines = outcome.data.filter((line) => line.trip_count > 0);
  const highestDelay = [...observedLines].sort(
    (left, right) => right.average_delay_seconds - left.average_delay_seconds,
  )[0];

  return [
    `Requested ${String(input.line_ids.length)} ${pluralize('line', input.line_ids.length)}.`,
    highestDelay === undefined
      ? outcome.data.length === 0
        ? 'No line health records were returned.'
        : 'No realtime observations were mapped for the requested IDs.'
      : `Highest average delay: Line ${highestDelay.line_id} at ${formatDuration(highestDelay.average_delay_seconds)}.`,
  ];
}

function summarizeExternalImpacts(
  input: GetExternalImpactsInput,
  outcome: SourceOutcome<MatchedExternalImpact[]>,
): string[] {
  const mostSevere = [...outcome.data].sort(
    (left, right) => severityRank(right.severity) - severityRank(left.severity),
  )[0];
  const requestedCorridors =
    input.corridors === undefined || input.corridors.length === 0
      ? 'all configured corridors'
      : input.corridors.join(', ');

  return [
    `Window: ${input.date_from} to ${input.date_to}.`,
    `Corridors: ${requestedCorridors}.`,
    mostSevere === undefined
      ? 'No matching external impacts were returned.'
      : `Highest severity impact: ${mostSevere.title} (${mostSevere.severity}).`,
  ];
}

function summarizeServiceNotices(
  input: GetServiceNoticesInput,
  outcome: SourceOutcome<ServiceNotice[]>,
): string[] {
  const requestedLines =
    input.line_ids === undefined || input.line_ids.length === 0
      ? 'all lines'
      : input.line_ids.join(', ');
  const requestedStops =
    input.stop_names === undefined || input.stop_names.length === 0
      ? 'all stops'
      : input.stop_names.join(', ');

  return [
    `Lines: ${requestedLines}.`,
    `Stops: ${requestedStops}.`,
    `Matched ${String(outcome.data.length)} ${pluralize('notice', outcome.data.length)}.`,
  ];
}

function summarizeShiftBrief(
  input: ShiftBriefBuildInput,
  outcome: SourceOutcome<ShiftBrief>,
): string[] {
  const topRisk = outcome.data.line_assessments[0];
  const requestedCorridors =
    input.corridors === undefined || input.corridors.length === 0
      ? 'all configured corridors'
      : input.corridors.join(', ');

  return [
    `Date: ${input.date}.`,
    `Corridors: ${requestedCorridors}.`,
    topRisk === undefined
      ? 'No line assessments were returned.'
      : `Top line risk: Line ${topRisk.target_id} is ${topRisk.band} at score ${String(topRisk.score)}.`,
  ];
}

function summarizePassengerInformationDraft(
  input: DraftPassengerInformationInput,
  draft: PassengerInformationDraft,
): string[] {
  return [
    `Channel: ${input.channel}.`,
    `Lines: ${input.line_ids.join(', ')}.`,
    `Draft length: ${String(draft.character_count)} characters.`,
  ];
}

function dedupeStrings(values: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const rawValue of values) {
    const value = rawValue.trim();

    if (value.length === 0 || seen.has(value)) {
      continue;
    }

    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainderSeconds = rounded % 60;

  if (minutes === 0) {
    return `${String(remainderSeconds)}s`;
  }

  if (remainderSeconds === 0) {
    return `${String(minutes)}m`;
  }

  return `${String(minutes)}m ${String(remainderSeconds)}s`;
}

function pluralize(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}

function severityRank(value: MatchedExternalImpact['severity']): number {
  switch (value) {
    case 'low':
      return 0;
    case 'moderate':
      return 1;
    case 'high':
      return 2;
    case 'severe':
      return 3;
  }
}

function toolErrorResult(error: unknown): CallToolResult {
  const message =
    error instanceof InputError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);

  return {
    content: [
      {
        type: 'text',
        text: message,
      },
    ],
    isError: true,
  };
}
