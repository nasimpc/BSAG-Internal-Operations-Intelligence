import type { DelayObservation, LineHealth } from '../domain/models.js';
import { type SourceOutcome, warning } from '../domain/result.js';
import type { Clock } from '../shared/clock.js';
import type {
  DatabaseRepositories,
  HistoricalSnapshot,
} from '../storage/repositories.js';
import type { VbnRealtimeRecord } from '../sources/vbn-realtime.js';

const MAX_LINE_IDS = 100;
const HISTORICAL_LOOKBACK_SECONDS = 15 * 60;
const DEFAULT_ON_TIME_THRESHOLD_SECONDS = 300;
const DEFAULT_EARLY_RUNNING_THRESHOLD_SECONDS = 60;
const DEFAULT_LOW_COVERAGE_THRESHOLD = 0.75;
const FALLBACK_SOURCE_URL = 'https://realtime.invalid/vbn-realtime';
const OPAQUE_GTFS_ROUTE_ID_PATTERN = /^\d+_\d+$/;

export interface GetLineHealthInput {
  line_ids: string[];
  at_time?: string;
}

export interface LineHealthThresholdOptions {
  onTimeThresholdSeconds?: number;
  earlyRunningThresholdSeconds?: number;
  lowCoverageThreshold?: number;
}

export type LineRouteMap = ReadonlyMap<string, readonly string[]>;

export interface LineHealthServiceOptions extends LineHealthThresholdOptions {
  source: {
    fetch(): Promise<SourceOutcome<VbnRealtimeRecord[]>>;
  };
  repositories: DatabaseRepositories;
  clock: Clock;
  refreshIntervalSeconds: number;
  retentionDays: number;
  routeMap?: LineRouteMap;
}

export class LineHealthService {
  readonly #source;
  readonly #repositories;
  readonly #clock;
  readonly #routeMap: LineRouteMap;
  readonly #refreshIntervalSeconds: number;
  readonly #retentionDays: number;
  readonly #thresholds: Required<LineHealthThresholdOptions>;
  #refreshPromise: Promise<SourceOutcome<VbnRealtimeRecord[]>> | undefined;

  constructor(options: LineHealthServiceOptions) {
    this.#source = options.source;
    this.#repositories = options.repositories;
    this.#clock = options.clock;
    this.#routeMap = normalizeLineRouteMap(options.routeMap);
    this.#refreshIntervalSeconds = options.refreshIntervalSeconds;
    this.#retentionDays = options.retentionDays;
    this.#thresholds = {
      onTimeThresholdSeconds:
        options.onTimeThresholdSeconds ?? DEFAULT_ON_TIME_THRESHOLD_SECONDS,
      earlyRunningThresholdSeconds:
        options.earlyRunningThresholdSeconds ??
        DEFAULT_EARLY_RUNNING_THRESHOLD_SECONDS,
      lowCoverageThreshold:
        options.lowCoverageThreshold ?? DEFAULT_LOW_COVERAGE_THRESHOLD,
    };
  }

  async get(input: GetLineHealthInput): Promise<SourceOutcome<LineHealth[]>> {
    const requestedLineIds = normalizeRequestedLineIds(input.line_ids);
    const atTime = input.at_time;

    if (atTime !== undefined) {
      return this.buildHistoricalOutcome(requestedLineIds, atTime);
    }

    const now = this.#clock.now().toISOString();
    const sourceState = this.#repositories.sourceState.get('vbn_realtime');

    if (
      sourceState !== undefined &&
      ageSeconds(sourceState.fetchedAt, now) < this.#refreshIntervalSeconds
    ) {
      return this.buildRepositoryOutcome(
        requestedLineIds,
        now,
        this.#refreshIntervalSeconds,
        {
          source: 'vbn_realtime',
          fetched_at: sourceState.fetchedAt,
          age_seconds: ageSeconds(sourceState.fetchedAt, now),
          stale: false,
        },
        [],
      );
    }

    try {
      const refreshOutcome = await this.refreshNow();

      return this.persistAndSummarize(requestedLineIds, now, refreshOutcome);
    } catch (error) {
      if (sourceState === undefined) {
        throw error;
      }

      const staleAgeSeconds = ageSeconds(sourceState.fetchedAt, now);

      return this.buildRepositoryOutcome(
        requestedLineIds,
        now,
        HISTORICAL_LOOKBACK_SECONDS,
        {
          source: 'vbn_realtime',
          fetched_at: sourceState.fetchedAt,
          age_seconds: staleAgeSeconds,
          stale: true,
        },
        [
          warning(
            'vbn_realtime',
            'SOURCE_REFRESH_FAILED',
            `Using cached realtime snapshot after refresh failure: ${describeError(error)}`,
            {
              occurredAt: now,
              retryable: false,
              staleCacheUsed: true,
              staleAgeSeconds,
            },
          ),
        ],
      );
    }
  }

  private buildHistoricalOutcome(
    lineIds: string[],
    atTime: string,
  ): SourceOutcome<LineHealth[]> {
    return this.buildRepositoryOutcome(
      lineIds,
      atTime,
      HISTORICAL_LOOKBACK_SECONDS,
      {
        source: 'vbn_realtime',
        stale: false,
      },
      [],
    );
  }

  private buildRepositoryOutcome(
    lineIds: string[],
    atTime: string,
    maxAgeSeconds: number,
    sourceStatus: SourceOutcome<never[]>['sources'][number],
    extraWarnings: SourceOutcome<LineHealth[]>['warnings'],
  ): SourceOutcome<LineHealth[]> {
    const snapshotLineIds =
      this.#repositories.realtime.findSnapshotLineIdsAtOrBefore(
        'vbn_realtime',
        atTime,
        maxAgeSeconds,
      );
    const lineHealth = lineIds.map((lineId) => {
      const resolved = this.resolveObservationLineIds(lineId);
      const snapshots = resolved.observationLineIds
        .map((observationLineId) =>
          this.#repositories.realtime.findSnapshotAtOrBefore(
            observationLineId,
            atTime,
            maxAgeSeconds,
          ),
        )
        .filter(
          (snapshot): snapshot is HistoricalSnapshot => snapshot !== undefined,
        );
      const snapshotAt =
        newestSnapshotAt(snapshots) ?? snapshotLineIds?.snapshotAt ?? atTime;
      const records = snapshots
        .filter((snapshot) => snapshot.snapshotAt === snapshotAt)
        .flatMap((snapshot) =>
          snapshot.observations.map((observation) =>
            recordFromObservation(observation),
          ),
        );

      return summarizeRequestedLineHealth(
        lineId,
        snapshotAt,
        records,
        snapshotLineIds?.lineIds ?? [],
        this.#thresholds,
        resolved.hasConfiguredMapping,
      );
    });

    return {
      data: lineHealth,
      sources: [sourceStatus],
      warnings: [...extraWarnings, ...collectLineWarnings(lineHealth)],
    };
  }

  private persistAndSummarize(
    requestedLineIds: string[],
    fetchedAt: string,
    outcome: SourceOutcome<VbnRealtimeRecord[]>,
  ): SourceOutcome<LineHealth[]> {
    const snapshotAt = outcome.data[0]?.observed_at ?? fetchedAt;

    this.#repositories.realtime.writeSnapshot(
      'vbn_realtime',
      snapshotAt,
      outcome.data.map((record) => observationFromRecord(record, fetchedAt)),
      {
        cleanupAsOf: fetchedAt,
        fetchedAt,
        retentionDays: this.#retentionDays,
      },
    );

    const recordsByLine = groupRecordsByLine(outcome.data);
    const feedLineIds = [...recordsByLine.keys()];
    const lineHealth = requestedLineIds.map((lineId) => {
      const resolved = this.resolveObservationLineIds(lineId);

      return summarizeRequestedLineHealth(
        lineId,
        snapshotAt,
        collectRecordsForLineIds(recordsByLine, resolved.observationLineIds),
        feedLineIds,
        this.#thresholds,
        resolved.hasConfiguredMapping,
      );
    });

    return {
      data: lineHealth,
      sources: outcome.sources,
      warnings: [...outcome.warnings, ...collectLineWarnings(lineHealth)],
    };
  }

  private refreshNow(): Promise<SourceOutcome<VbnRealtimeRecord[]>> {
    if (!this.#refreshPromise) {
      this.#refreshPromise = (async () => {
        try {
          return await this.#source.fetch();
        } finally {
          this.#refreshPromise = undefined;
        }
      })();
    }

    return this.#refreshPromise;
  }

  private resolveObservationLineIds(lineId: string): {
    observationLineIds: string[];
    hasConfiguredMapping: boolean;
  } {
    const mappedRouteIds = lookupMappedRouteIds(this.#routeMap, lineId);

    if (mappedRouteIds.length === 0) {
      return {
        observationLineIds: [lineId],
        hasConfiguredMapping: false,
      };
    }

    return {
      observationLineIds: dedupeLineIds([lineId, ...mappedRouteIds]),
      hasConfiguredMapping: true,
    };
  }
}

function summarizeRequestedLineHealth(
  lineId: string,
  snapshotAt: string,
  records: readonly VbnRealtimeRecord[],
  feedLineIds: readonly string[],
  options: LineHealthThresholdOptions = {},
  hasConfiguredMapping = false,
): LineHealth {
  const health = summarizeLineHealth(lineId, snapshotAt, records, options);

  if (records.length > 0 || !hasOpaqueGtfsRouteIds(feedLineIds)) {
    return health;
  }

  if (hasConfiguredMapping || looksLikeOpaqueGtfsRouteId(lineId)) {
    return health;
  }

  return {
    ...health,
    warnings: [
      warning(
        'vbn_realtime',
        'ROUTE_MAPPING_UNAVAILABLE',
        routeMappingUnavailableMessage(lineId, feedLineIds),
        {
          occurredAt: snapshotAt,
          retryable: false,
        },
      ),
    ],
  };
}

export function summarizeLineHealth(
  lineId: string,
  snapshotAt: string,
  records: readonly VbnRealtimeRecord[],
  options: LineHealthThresholdOptions = {},
): LineHealth {
  const thresholds = {
    onTimeThresholdSeconds:
      options.onTimeThresholdSeconds ?? DEFAULT_ON_TIME_THRESHOLD_SECONDS,
    earlyRunningThresholdSeconds:
      options.earlyRunningThresholdSeconds ??
      DEFAULT_EARLY_RUNNING_THRESHOLD_SECONDS,
    lowCoverageThreshold:
      options.lowCoverageThreshold ?? DEFAULT_LOW_COVERAGE_THRESHOLD,
  };
  const usableDelays = records
    .filter(
      (record): record is VbnRealtimeRecord & { delay_seconds: number } =>
        record.has_usable_delay && record.delay_seconds !== undefined,
    )
    .map((record) => record.delay_seconds);
  const tripCount = records.length;
  const observedTripCount = usableDelays.length;
  const coverageRatio = tripCount === 0 ? 0 : observedTripCount / tripCount;
  const cancellations = records.filter(
    (record) => record.schedule_relationship === 'canceled',
  ).length;
  const skippedStops = records.filter(
    (record) => record.schedule_relationship === 'skipped',
  ).length;
  const warnings =
    tripCount === 0
      ? [
          warning(
            'vbn_realtime',
            'NO_OBSERVATIONS',
            `No realtime observations were available for line ${lineId}`,
            {
              occurredAt: snapshotAt,
              retryable: false,
            },
          ),
        ]
      : buildCoverageWarnings(
          lineId,
          snapshotAt,
          tripCount,
          observedTripCount,
          coverageRatio,
          thresholds.lowCoverageThreshold,
        );
  const sortedDelays = [...usableDelays].sort((left, right) => left - right);

  return {
    line_id: lineId,
    snapshot_at: snapshotAt,
    trip_count: tripCount,
    observed_trip_count: observedTripCount,
    coverage_ratio: coverageRatio,
    average_delay_seconds: average(sortedDelays),
    median_delay_seconds: median(sortedDelays),
    p95_delay_seconds: nearestRank(sortedDelays, 0.95),
    max_delay_seconds: sortedDelays.at(-1) ?? 0,
    on_time_percentage: onTimePercentage(
      sortedDelays,
      thresholds.onTimeThresholdSeconds,
      thresholds.earlyRunningThresholdSeconds,
    ),
    cancellations,
    skipped_stops: skippedStops,
    warnings,
  };
}

function buildCoverageWarnings(
  lineId: string,
  snapshotAt: string,
  tripCount: number,
  observedTripCount: number,
  coverageRatio: number,
  lowCoverageThreshold: number,
): LineHealth['warnings'] {
  if (observedTripCount === 0) {
    return [
      warning(
        'vbn_realtime',
        'NO_USABLE_DELAYS',
        `No usable delays were available for line ${lineId}`,
        {
          occurredAt: snapshotAt,
          retryable: false,
        },
      ),
    ];
  }

  if (tripCount > 0 && coverageRatio < lowCoverageThreshold) {
    return [
      warning(
        'vbn_realtime',
        'LOW_DELAY_COVERAGE',
        `Delay coverage for line ${lineId} is ${String(observedTripCount)}/${String(tripCount)}`,
        {
          occurredAt: snapshotAt,
          retryable: false,
        },
      ),
    ];
  }

  return [];
}

function observationFromRecord(
  record: VbnRealtimeRecord,
  fetchedAt: string,
): DelayObservation {
  return {
    line_id: record.route_id,
    ...(record.entity_id === undefined ? {} : { entity_id: record.entity_id }),
    observed_at: record.observed_at,
    delay_seconds: record.delay_seconds ?? 0,
    has_usable_delay: record.has_usable_delay,
    schedule_relationship: record.schedule_relationship,
    ...(record.trip_id === undefined ? {} : { trip_id: record.trip_id }),
    update_count: record.update_count,
    provenance: {
      source: 'vbn_realtime',
      sourceUrl: FALLBACK_SOURCE_URL,
      fetchedAt: fetchedAt,
    },
  };
}

function recordFromObservation(
  observation: DelayObservation,
): VbnRealtimeRecord {
  return {
    route_id: observation.line_id,
    ...(observation.entity_id === undefined
      ? {}
      : { entity_id: observation.entity_id }),
    ...(observation.trip_id === undefined
      ? {}
      : { trip_id: observation.trip_id }),
    observed_at: observation.observed_at,
    ...(observation.has_usable_delay
      ? { delay_seconds: observation.delay_seconds }
      : observation.delay_seconds !== 0
        ? { delay_seconds: observation.delay_seconds }
        : {}),
    has_usable_delay: observation.has_usable_delay ?? true,
    schedule_relationship: observation.schedule_relationship ?? 'scheduled',
    update_count: observation.update_count ?? 1,
  };
}

function groupRecordsByLine(
  records: readonly VbnRealtimeRecord[],
): Map<string, VbnRealtimeRecord[]> {
  const grouped = new Map<string, VbnRealtimeRecord[]>();

  for (const record of records) {
    const existing = grouped.get(record.route_id);

    if (existing) {
      existing.push(record);
    } else {
      grouped.set(record.route_id, [record]);
    }
  }

  return grouped;
}

function collectRecordsForLineIds(
  recordsByLine: ReadonlyMap<string, readonly VbnRealtimeRecord[]>,
  lineIds: readonly string[],
): VbnRealtimeRecord[] {
  return lineIds.flatMap((lineId) => recordsByLine.get(lineId) ?? []);
}

function newestSnapshotAt(
  snapshots: readonly HistoricalSnapshot[],
): string | undefined {
  return snapshots.reduce<string | undefined>(
    (newest, snapshot) =>
      newest === undefined || snapshot.snapshotAt > newest
        ? snapshot.snapshotAt
        : newest,
    undefined,
  );
}

function normalizeLineRouteMap(
  routeMap: LineRouteMap | undefined,
): LineRouteMap {
  const normalized = new Map<string, readonly string[]>();

  if (routeMap === undefined) {
    return normalized;
  }

  for (const [lineId, routeIds] of routeMap) {
    const normalizedLineId = lineId.trim();
    const normalizedRouteIds = dedupeLineIds(routeIds);

    if (normalizedLineId.length > 0 && normalizedRouteIds.length > 0) {
      normalized.set(normalizedLineId, Object.freeze(normalizedRouteIds));
    }
  }

  return normalized;
}

function lookupMappedRouteIds(
  routeMap: LineRouteMap,
  lineId: string,
): readonly string[] {
  const exact = routeMap.get(lineId);

  if (exact !== undefined) {
    return exact;
  }

  const upper = lineId.toUpperCase();

  if (upper === lineId) {
    return [];
  }

  return routeMap.get(upper) ?? [];
}

function dedupeLineIds(lineIds: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const lineId of lineIds) {
    const trimmed = lineId.trim();

    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function hasOpaqueGtfsRouteIds(lineIds: readonly string[]): boolean {
  return lineIds.some((lineId) => looksLikeOpaqueGtfsRouteId(lineId));
}

function looksLikeOpaqueGtfsRouteId(lineId: string): boolean {
  return OPAQUE_GTFS_ROUTE_ID_PATTERN.test(lineId);
}

function routeMappingUnavailableMessage(
  lineId: string,
  feedLineIds: readonly string[],
): string {
  const sampleIds = [...new Set(feedLineIds)]
    .filter((candidate) => looksLikeOpaqueGtfsRouteId(candidate))
    .sort()
    .slice(0, 3);
  const sampleText =
    sampleIds.length === 0
      ? ''
      : ` Sample feed route IDs: ${sampleIds.join(', ')}.`;

  return (
    `VBN GTFS-Realtime observations are keyed by static GTFS route IDs, but requested line ${lineId} is a public line label and no static GTFS route mapping is configured.` +
    sampleText +
    ' No line-health conclusion was made for this requested ID.'
  );
}

function collectLineWarnings(lineHealth: readonly LineHealth[]) {
  return lineHealth.flatMap((line) => line.warnings);
}

function normalizeRequestedLineIds(lineIds: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const lineId of lineIds) {
    const trimmed = lineId.trim();

    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  if (normalized.length === 0) {
    throw new Error('line_ids must contain at least one non-empty line ID');
  }

  if (normalized.length > MAX_LINE_IDS) {
    throw new Error(
      `line_ids must contain no more than ${String(MAX_LINE_IDS)} unique IDs`,
    );
  }

  return normalized;
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const middleIndex = Math.floor(values.length / 2);

  if (values.length % 2 === 1) {
    return values[middleIndex] ?? 0;
  }

  const left = values[middleIndex - 1];
  const right = values[middleIndex];

  return ((left ?? 0) + (right ?? 0)) / 2;
}

function nearestRank(values: readonly number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }

  const rank = Math.max(1, Math.ceil(percentile * values.length));

  return values[rank - 1] ?? 0;
}

function onTimePercentage(
  delays: readonly number[],
  onTimeThresholdSeconds: number,
  earlyRunningThresholdSeconds: number,
): number {
  if (delays.length === 0) {
    return 0;
  }

  const onTimeCount = delays.filter(
    (delay) =>
      delay <= onTimeThresholdSeconds && delay >= -earlyRunningThresholdSeconds,
  ).length;

  return (onTimeCount / delays.length) * 100;
}

function ageSeconds(earlierIso: string, laterIso: string): number {
  return Math.max(
    0,
    Math.floor((Date.parse(laterIso) - Date.parse(earlierIso)) / 1000),
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
