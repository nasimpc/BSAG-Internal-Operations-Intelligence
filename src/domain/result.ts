import type {
  SourceId,
  SourceStatus,
  SourceWarning,
  ToolEnvelope,
} from './models.js';

export interface SourceOutcome<T> {
  data: T;
  sources: SourceStatus[];
  warnings: SourceWarning[];
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
    sources: outcome.sources,
    warnings: outcome.warnings,
  };
}

export function combineOutcomes<T>(
  outcomes: SourceOutcome<T[]>[],
  generatedAt: string,
): ToolEnvelope<T[]> {
  return envelope(generatedAt, {
    data: outcomes.flatMap((outcome) => outcome.data),
    sources: outcomes.flatMap((outcome) => outcome.sources),
    warnings: outcomes.flatMap((outcome) => outcome.warnings),
  });
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
