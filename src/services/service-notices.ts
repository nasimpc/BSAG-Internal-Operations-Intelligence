import type {
  ServiceNotice,
  SourceId,
  SourceWarning,
} from '../domain/models.js';
import { type SourceOutcome, warning } from '../domain/result.js';
import type { Clock } from '../shared/clock.js';
import type { DatabaseRepositories } from '../storage/repositories.js';

const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_MAX_RESULTS = 50;
const DAY_IN_MILLISECONDS = 86_400_000;

export interface GetServiceNoticesInput {
  line_ids?: string[];
  stop_names?: string[];
  since?: string;
}

export interface ServiceNoticeSource {
  readonly sourceId: Extract<SourceId, 'bsag' | 'vbn_notices'>;
  fetch(): Promise<SourceOutcome<ServiceNotice[]>>;
}

export interface ServiceNoticeServiceOptions {
  clock: Clock;
  maxResults?: number;
  repositories: DatabaseRepositories;
  sources: readonly ServiceNoticeSource[];
}

interface RefreshedSource {
  notices: ServiceNotice[];
  sourceStatuses: SourceOutcome<ServiceNotice[]>['sources'];
  warnings: SourceWarning[];
}

export class ServiceNoticeService {
  readonly #clock: Clock;
  readonly #maxResults: number;
  readonly #repositories: DatabaseRepositories;
  readonly #sources: readonly ServiceNoticeSource[];

  constructor(options: ServiceNoticeServiceOptions) {
    this.#clock = options.clock;
    this.#maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
    this.#repositories = options.repositories;
    this.#sources = [...options.sources];
  }

  async get(
    input: GetServiceNoticesInput = {},
  ): Promise<SourceOutcome<ServiceNotice[]>> {
    const now = this.#clock.now().toISOString();
    const since = input.since ?? defaultSince(this.#clock.now());
    const requestedLines = normalizeLineIds(input.line_ids);
    const requestedStops = normalizeStopNames(input.stop_names);
    const refreshes = await Promise.allSettled(
      this.#sources.map(async (source) => ({
        sourceId: source.sourceId,
        refreshed: await source.fetch(),
      })),
    );

    const aggregated: ServiceNotice[] = [];
    const warnings: SourceWarning[] = [];
    const sourceStatuses: SourceOutcome<ServiceNotice[]>['sources'] = [];

    for (const refresh of refreshes) {
      if (refresh.status === 'fulfilled') {
        const fetchedAt = sourceFetchedAt(refresh.value.refreshed, now);

        this.#repositories.serviceNotices.replaceForSource(
          refresh.value.sourceId,
          refresh.value.refreshed.data,
          fetchedAt,
        );

        aggregated.push(...refresh.value.refreshed.data);
        sourceStatuses.push(...refresh.value.refreshed.sources);
        warnings.push(...refresh.value.refreshed.warnings);
        continue;
      }

      const sourceId = sourceIdFromErrorIndex(refreshes, refresh);

      if (sourceId === undefined) {
        continue;
      }

      const fallback = this.cachedFallback(sourceId, now, refresh.reason);

      aggregated.push(...fallback.notices);
      sourceStatuses.push(...fallback.sourceStatuses);
      warnings.push(...fallback.warnings);
    }

    const filtered = deduplicateNotices(aggregated)
      .filter((notice) => matchesSince(notice, since))
      .filter((notice) => matchesLines(notice, requestedLines))
      .filter((notice) => matchesStops(notice, requestedStops))
      .sort(compareNotices);

    if (filtered.length <= this.#maxResults) {
      return {
        data: filtered,
        sources: sourceStatuses,
        warnings,
      };
    }

    const truncated = filtered.slice(0, this.#maxResults);
    const truncatedWarningSource =
      filtered[this.#maxResults]?.provenance.source ??
      truncated[0]?.provenance.source ??
      'bsag';

    return {
      data: truncated,
      sources: sourceStatuses,
      warnings: [
        ...warnings,
        warning(
          truncatedWarningSource,
          'RESULT_TRUNCATED',
          `Service notice result was truncated to ${String(this.#maxResults)} records`,
          {
            occurredAt: now,
            retryable: false,
          },
        ),
      ],
    };
  }

  private cachedFallback(
    sourceId: Extract<SourceId, 'bsag' | 'vbn_notices'>,
    now: string,
    error: unknown,
  ): RefreshedSource {
    const sourceState = this.#repositories.sourceState.get(sourceId);

    if (sourceState === undefined) {
      return {
        notices: [],
        sourceStatuses: [
          {
            source: sourceId,
            stale: true,
          },
        ],
        warnings: [
          warning(
            sourceId,
            'SOURCE_REFRESH_FAILED',
            `Source refresh failed without cache: ${describeError(error)}`,
            {
              occurredAt: now,
              retryable: false,
            },
          ),
        ],
      };
    }

    const staleAgeSeconds = ageSeconds(sourceState.fetchedAt, now);

    return {
      notices: this.#repositories.serviceNotices
        .listAll()
        .filter((notice) => notice.provenance.source === sourceId),
      sourceStatuses: [
        {
          source: sourceId,
          fetched_at: sourceState.fetchedAt,
          age_seconds: staleAgeSeconds,
          stale: true,
        },
      ],
      warnings: [
        warning(
          sourceId,
          'SOURCE_REFRESH_FAILED',
          `Using cached service notices after refresh failure: ${describeError(error)}`,
          {
            occurredAt: now,
            retryable: false,
            staleAgeSeconds,
            staleCacheUsed: true,
          },
        ),
      ],
    };
  }
}

function sourceIdFromErrorIndex(
  refreshes: PromiseSettledResult<{
    sourceId: Extract<SourceId, 'bsag' | 'vbn_notices'>;
    refreshed: SourceOutcome<ServiceNotice[]>;
  }>[],
  failedRefresh: PromiseRejectedResult,
): Extract<SourceId, 'bsag' | 'vbn_notices'> | undefined {
  const failedIndex = refreshes.indexOf(failedRefresh);

  if (failedIndex < 0) {
    return undefined;
  }

  return failedIndex === 0
    ? 'bsag'
    : failedIndex === 1
      ? 'vbn_notices'
      : undefined;
}

function sourceFetchedAt(
  outcome: SourceOutcome<ServiceNotice[]>,
  now: string,
): string {
  return (
    outcome.sources.find(
      (sourceStatus) => sourceStatus.fetched_at !== undefined,
    )?.fetched_at ??
    outcome.data[0]?.provenance.fetchedAt ??
    now
  );
}

function defaultSince(now: Date): string {
  return new Date(
    now.getTime() - DEFAULT_LOOKBACK_DAYS * DAY_IN_MILLISECONDS,
  ).toISOString();
}

function normalizeLineIds(lineIds: string[] | undefined): Set<string> {
  return new Set(
    (lineIds ?? [])
      .map((lineId) => lineId.trim().toUpperCase())
      .filter((lineId) => lineId.length > 0),
  );
}

function normalizeStopNames(stopNames: string[] | undefined): Set<string> {
  return new Set(
    (stopNames ?? [])
      .map((stopName) => normalizeText(stopName))
      .filter((stopName) => stopName.length > 0),
  );
}

function matchesLines(
  notice: ServiceNotice,
  requestedLines: Set<string>,
): boolean {
  if (requestedLines.size === 0) {
    return true;
  }

  return notice.lines.some((lineId) =>
    requestedLines.has(lineId.toUpperCase()),
  );
}

function matchesStops(
  notice: ServiceNotice,
  requestedStops: Set<string>,
): boolean {
  if (requestedStops.size === 0) {
    return true;
  }

  return notice.stop_names.some((stopName) =>
    requestedStops.has(normalizeText(stopName)),
  );
}

function matchesSince(notice: ServiceNotice, since: string): boolean {
  const sinceTime = Date.parse(since);

  if (notice.valid_from !== undefined || notice.valid_to !== undefined) {
    if (notice.valid_to === undefined) {
      return true;
    }

    return Date.parse(notice.valid_to) >= sinceTime;
  }

  return referenceTimestamp(notice) >= sinceTime;
}

function deduplicateNotices(notices: ServiceNotice[]): ServiceNotice[] {
  const deduplicated = new Map<string, ServiceNotice>();

  for (const notice of notices) {
    const key = dedupeKey(notice);
    const existing = deduplicated.get(key);

    if (existing === undefined || compareNoticePriority(notice, existing) < 0) {
      deduplicated.set(key, notice);
    }
  }

  return [...deduplicated.values()];
}

function dedupeKey(notice: ServiceNotice): string {
  return [
    normalizeText(notice.title),
    normalizeText(notice.summary),
    notice.lines
      .map((line) => line.toUpperCase())
      .sort()
      .join(','),
    notice.stop_names
      .map((stop) => normalizeText(stop))
      .sort()
      .join(','),
    notice.valid_from ?? '',
    notice.valid_to ?? '',
  ].join('|');
}

function compareNoticePriority(
  left: ServiceNotice,
  right: ServiceNotice,
): number {
  const leftSourcePriority = sourcePriority(left.provenance.source);
  const rightSourcePriority = sourcePriority(right.provenance.source);

  if (leftSourcePriority !== rightSourcePriority) {
    return leftSourcePriority - rightSourcePriority;
  }

  return referenceTimestamp(right) - referenceTimestamp(left);
}

function compareNotices(left: ServiceNotice, right: ServiceNotice): number {
  const leftEffective = isEffectiveNotice(left);
  const rightEffective = isEffectiveNotice(right);

  if (leftEffective !== rightEffective) {
    return leftEffective ? -1 : 1;
  }

  const recencyDifference =
    referenceTimestamp(right) - referenceTimestamp(left);

  if (recencyDifference !== 0) {
    return recencyDifference;
  }

  return left.id.localeCompare(right.id);
}

function isEffectiveNotice(notice: ServiceNotice): boolean {
  return notice.valid_from !== undefined || notice.valid_to !== undefined;
}

function referenceTimestamp(notice: ServiceNotice): number {
  const reference =
    notice.provenance.publishedAt ?? notice.provenance.fetchedAt;

  return Date.parse(reference);
}

function sourcePriority(source: SourceId): number {
  switch (source) {
    case 'bsag':
      return 0;
    case 'vbn_notices':
      return 1;
    default:
      return 2;
  }
}

function ageSeconds(from: string, to: string): number {
  return Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 1000));
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLowerCase();
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
