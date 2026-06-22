import type {
  Citation,
  SourceId,
  SourceStatus,
  SourceWarning,
  ToolEnvelope,
} from './models.js';

export interface SourceOutcome<T> {
  data: T;
  sources: SourceStatus[];
  warnings: SourceWarning[];
  citations?: Citation[];
}

export interface CombinedOutcome<T> extends SourceOutcome<T> {
  status: 'complete' | 'partial';
}

export function envelope<T>(
  generatedAt: string,
  outcome: SourceOutcome<T>,
): ToolEnvelope<T> {
  return {
    generated_at: generatedAt,
    timezone: 'Europe/Berlin',
    status: outcome.warnings.length === 0 ? 'complete' : 'partial',
    data: outcome.data,
    citations: outcome.citations ?? [],
    sources: outcome.sources,
    warnings: outcome.warnings,
  };
}

export function combineOutcomes<T>(
  outcomes: SourceOutcome<T[]>[],
): CombinedOutcome<T[]> {
  const citations = outcomes.flatMap((outcome) => outcome.citations ?? []);
  const combined = {
    data: outcomes.flatMap((outcome) => outcome.data),
    sources: outcomes.flatMap((outcome) => outcome.sources),
    warnings: outcomes.flatMap((outcome) => outcome.warnings),
  };

  return {
    ...combined,
    ...(citations.length === 0 ? {} : { citations }),
    status: combined.warnings.length === 0 ? 'complete' : 'partial',
  };
}

export function warning(
  source: SourceId,
  code: string,
  message: string,
  options: {
    occurredAt: string;
    retryable: boolean;
    staleCacheUsed?: boolean;
    staleAgeSeconds?: number;
  },
): SourceWarning {
  return {
    source,
    code,
    message,
    occurred_at: options.occurredAt,
    retryable: options.retryable,
    ...(options.staleCacheUsed === undefined
      ? {}
      : { stale_cache_used: options.staleCacheUsed }),
    ...(options.staleAgeSeconds === undefined
      ? {}
      : { stale_age_seconds: options.staleAgeSeconds }),
  };
}
