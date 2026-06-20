import type { Corridor, CorridorMatch } from '../config/corridors.js';
import { matchCorridor } from '../config/corridors.js';
import type {
  ExternalImpact,
  SourceId,
  SourceWarning,
} from '../domain/models.js';
import { type SourceOutcome, warning } from '../domain/result.js';
import {
  type TimeInterval,
  InputError,
  intervalsOverlap,
  parseBerlinRange,
} from '../shared/dates.js';
import type { Clock } from '../shared/clock.js';
import type { DatabaseRepositories } from '../storage/repositories.js';

const SEVERITY_RANK = {
  severe: 0,
  high: 1,
  moderate: 2,
  low: 3,
} as const;

export interface GetExternalImpactsInput {
  corridors?: string[];
  date_from: string;
  date_to: string;
}

export interface MatchedExternalImpact extends ExternalImpact {
  corridor_matches: CorridorMatch[];
}

export interface ExternalImpactSource {
  readonly sourceIds: readonly SourceId[];
  fetch(): Promise<SourceOutcome<ExternalImpact[]>>;
}

export interface ExternalImpactServiceOptions {
  clock: Clock;
  corridors: ReadonlyArray<Readonly<Corridor>>;
  repositories: DatabaseRepositories;
  sources: readonly ExternalImpactSource[];
}

export class ExternalImpactService {
  readonly #clock: Clock;
  readonly #corridors: ReadonlyArray<Readonly<Corridor>>;
  readonly #repositories: DatabaseRepositories;
  readonly #sources: readonly ExternalImpactSource[];

  constructor(options: ExternalImpactServiceOptions) {
    this.#clock = options.clock;
    this.#corridors = options.corridors;
    this.#repositories = options.repositories;
    this.#sources = [...options.sources];
  }

  async get(
    input: GetExternalImpactsInput,
  ): Promise<SourceOutcome<MatchedExternalImpact[]>> {
    const interval = parseBerlinRange(input.date_from, input.date_to);
    const selectedCorridors = resolveRequestedCorridors(
      this.#corridors,
      input.corridors,
    );
    const refreshes = await Promise.allSettled(
      this.#sources.map(async (source) => ({
        sourceIds: source.sourceIds,
        outcome: await source.fetch(),
      })),
    );
    const warnings: SourceWarning[] = [];
    const sourceStatuses: SourceOutcome<ExternalImpact[]>['sources'] = [];
    const impacts: ExternalImpact[] = [];
    const now = this.#clock.now().toISOString();

    for (let index = 0; index < refreshes.length; index += 1) {
      const refresh = refreshes[index];
      const source = this.#sources[index];

      if (source === undefined || refresh === undefined) {
        continue;
      }

      if (refresh.status === 'fulfilled') {
        persistOutcome(
          this.#repositories,
          refresh.value.outcome,
          source.sourceIds,
          now,
        );
        impacts.push(...refresh.value.outcome.data);
        sourceStatuses.push(...refresh.value.outcome.sources);
        warnings.push(...refresh.value.outcome.warnings);
        continue;
      }

      const fallback = buildCachedFallback(
        this.#repositories,
        source.sourceIds,
        now,
        refresh.reason,
      );

      impacts.push(...fallback.data);
      sourceStatuses.push(...fallback.sources);
      warnings.push(...fallback.warnings);
    }

    const matched = deduplicateImpacts(impacts)
      .map((impact) => ({
        impact,
        corridor_matches: findCorridorMatches(
          selectedCorridors,
          input.corridors === undefined ? this.#corridors : selectedCorridors,
          impact,
        ),
      }))
      .filter(({ impact }) => overlapsRange(impact, interval))
      .filter(({ corridor_matches }) =>
        input.corridors === undefined ? true : corridor_matches.length > 0,
      )
      .map(({ impact, corridor_matches }) => ({
        ...impact,
        corridor_matches,
      }))
      .sort(compareMatchedImpacts);

    return {
      data: matched,
      sources: sourceStatuses,
      warnings,
    };
  }
}

function resolveRequestedCorridors(
  allCorridors: ReadonlyArray<Readonly<Corridor>>,
  requestedIds: string[] | undefined,
): ReadonlyArray<Readonly<Corridor>> {
  if (requestedIds === undefined || requestedIds.length === 0) {
    return allCorridors;
  }

  return requestedIds.map((requestedId) => {
    const corridor = allCorridors.find(
      (candidate) => candidate.id === requestedId,
    );

    if (corridor === undefined) {
      throw new InputError(`Unknown corridor "${requestedId}"`);
    }

    return corridor;
  });
}

function persistOutcome(
  repositories: DatabaseRepositories,
  outcome: SourceOutcome<ExternalImpact[]>,
  sourceIds: readonly SourceId[],
  now: string,
): void {
  const impactsBySource = new Map<SourceId, ExternalImpact[]>();

  for (const sourceId of sourceIds) {
    impactsBySource.set(sourceId, []);
  }

  for (const impact of outcome.data) {
    const group = impactsBySource.get(impact.provenance.source);

    if (group !== undefined) {
      group.push(impact);
    }
  }

  for (const sourceId of sourceIds) {
    const sourceFetchedAt =
      outcome.sources.find((status) => status.source === sourceId)
        ?.fetched_at ?? now;

    repositories.externalImpacts.replaceForSource(
      sourceId,
      impactsBySource.get(sourceId) ?? [],
      sourceFetchedAt,
    );
  }
}

function buildCachedFallback(
  repositories: DatabaseRepositories,
  sourceIds: readonly SourceId[],
  now: string,
  error: unknown,
): SourceOutcome<ExternalImpact[]> {
  const cached = repositories.externalImpacts.listAll();
  const data: ExternalImpact[] = [];
  const sources: SourceOutcome<ExternalImpact[]>['sources'] = [];
  const warnings: SourceWarning[] = [];

  for (const sourceId of sourceIds) {
    const sourceState = repositories.sourceState.get(sourceId);

    if (sourceState === undefined) {
      sources.push({
        source: sourceId,
        stale: true,
      });
      warnings.push(
        warning(
          sourceId,
          'SOURCE_REFRESH_FAILED',
          `Source refresh failed without cache: ${describeError(error)}`,
          {
            occurredAt: now,
            retryable: false,
          },
        ),
      );
      continue;
    }

    const staleAgeSeconds = Math.max(
      0,
      Math.floor((Date.parse(now) - Date.parse(sourceState.fetchedAt)) / 1000),
    );

    data.push(
      ...cached.filter((impact) => impact.provenance.source === sourceId),
    );
    sources.push({
      source: sourceId,
      fetched_at: sourceState.fetchedAt,
      age_seconds: staleAgeSeconds,
      stale: true,
    });
    warnings.push(
      warning(
        sourceId,
        'SOURCE_REFRESH_FAILED',
        `Using cached external impacts after refresh failure: ${describeError(error)}`,
        {
          occurredAt: now,
          retryable: false,
          staleCacheUsed: true,
          staleAgeSeconds,
        },
      ),
    );
  }

  return { data, sources, warnings };
}

function findCorridorMatches(
  requestedCorridors: ReadonlyArray<Readonly<Corridor>>,
  allCorridors: ReadonlyArray<Readonly<Corridor>>,
  impact: ExternalImpact,
): CorridorMatch[] {
  const corridorsToCheck =
    requestedCorridors.length === allCorridors.length
      ? allCorridors
      : requestedCorridors;

  return corridorsToCheck
    .map((corridor) =>
      matchCorridor(corridor, {
        title: impact.title,
        text: [impact.summary, impact.details].filter(Boolean).join(' '),
        ...(impact.details === undefined ? {} : { location: impact.details }),
      }),
    )
    .filter((match): match is CorridorMatch => match !== undefined);
}

function overlapsRange(
  impact: ExternalImpact,
  interval: TimeInterval,
): boolean {
  const impactInterval = impactToInterval(impact);

  return intervalsOverlap(interval, impactInterval);
}

function impactToInterval(impact: ExternalImpact): TimeInterval {
  const start =
    impact.starts_at ??
    impact.ends_at ??
    impact.provenance.publishedAt ??
    impact.provenance.fetchedAt;
  const end =
    impact.ends_at ??
    impact.starts_at ??
    impact.provenance.publishedAt ??
    impact.provenance.fetchedAt;

  return {
    start: new Date(start),
    end: new Date(end),
  };
}

function deduplicateImpacts(impacts: ExternalImpact[]): ExternalImpact[] {
  const deduplicated = new Map<string, ExternalImpact>();

  for (const impact of impacts) {
    const key = dedupeKey(impact);
    const existing = deduplicated.get(key);

    if (
      existing === undefined ||
      sourcePriority(impact.provenance.source) <
        sourcePriority(existing.provenance.source)
    ) {
      deduplicated.set(key, impact);
    }
  }

  return [...deduplicated.values()];
}

function dedupeKey(impact: ExternalImpact): string {
  return [
    normalizeKey(impact.title),
    normalizeKey(impact.details ?? impact.summary),
    impact.starts_at ?? '',
    impact.ends_at ?? '',
    impact.category,
  ].join('|');
}

function sourcePriority(source: SourceId): number {
  switch (source) {
    case 'vmz_pdf':
      return 0;
    case 'vmz_web':
      return 1;
    case 'vmz_rss':
      return 2;
    case 'bremen_events':
      return 3;
    default:
      return 4;
  }
}

function compareMatchedImpacts(
  left: MatchedExternalImpact,
  right: MatchedExternalImpact,
): number {
  const severityDifference =
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];

  if (severityDifference !== 0) {
    return severityDifference;
  }

  const leftStart = left.starts_at ?? left.ends_at ?? left.provenance.fetchedAt;
  const rightStart =
    right.starts_at ?? right.ends_at ?? right.provenance.fetchedAt;

  return Date.parse(leftStart) - Date.parse(rightStart);
}

function normalizeKey(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/ß/gu, 'ss')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
