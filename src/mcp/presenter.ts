import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type {
  SourceStatus,
  SourceWarning,
  ToolEnvelope,
} from '../domain/models.js';

export interface PresentToolEnvelopeOptions<T> {
  title: string;
  summary: string[];
  envelope: ToolEnvelope<T>;
}

export function presentToolEnvelope<T>(
  options: PresentToolEnvelopeOptions<T>,
): CallToolResult {
  const sections = [
    `# ${options.title}`,
    [
      `Status: ${options.envelope.status}.`,
      `Generated at: ${options.envelope.generated_at} (${options.envelope.timezone}).`,
    ].join('\n'),
    options.summary.join('\n'),
    formatSourceSection(options.envelope.sources),
    formatWarningsSection(options.envelope.warnings),
    [
      'Structured data fallback:',
      '```json',
      JSON.stringify(options.envelope, null, 2),
      '```',
    ].join('\n'),
  ].filter((section) => section.trim().length > 0);

  return {
    content: [
      {
        type: 'text',
        text: sections.join('\n\n'),
      },
    ],
    structuredContent: options.envelope as unknown as Record<string, unknown>,
  };
}

function formatSourceSection(sources: readonly SourceStatus[]): string {
  if (sources.length === 0) {
    return [
      'Source freshness',
      '- No external source timestamps were reported.',
    ].join('\n');
  }

  return [
    'Source freshness',
    ...sources.map((source) => `- ${formatSourceStatus(source)}`),
  ].join('\n');
}

function formatSourceStatus(source: SourceStatus): string {
  const freshness =
    source.age_seconds === undefined
      ? 'freshness unavailable'
      : `${String(source.age_seconds)}s old`;
  const flags = source.stale ? 'stale' : 'fresh';
  const fetchedAt =
    source.fetched_at === undefined ? '' : ` (fetched ${source.fetched_at})`;

  return `${source.source}: ${freshness}; ${flags}${fetchedAt}.`;
}

function formatWarningsSection(warnings: readonly SourceWarning[]): string {
  if (warnings.length === 0) {
    return '';
  }

  return [
    'Warnings',
    ...warnings.map((warning) => `- ${formatWarning(warning)}`),
  ].join('\n');
}

function formatWarning(warning: SourceWarning): string {
  const staleCache =
    warning.stale_cache_used === true ? ' stale cache in use.' : '';

  return `${warning.source} ${warning.code}: ${warning.message}${staleCache}`;
}
