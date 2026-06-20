import { TZDate } from '@date-fns/tz';
import { load } from 'cheerio';

import type { ExternalImpact, SourceWarning } from '../domain/models.js';
import { type SourceOutcome, warning } from '../domain/result.js';
import { sha256Text } from '../shared/hash.js';

const BERLIN_TIMEZONE = 'Europe/Berlin';
const EVENT_DETAIL_PRIORITY = {
  jsonld: 0,
  html: 1,
} as const;

type EventOrigin = keyof typeof EVENT_DETAIL_PRIORITY;

interface ParsedEventCandidate extends ExternalImpact {
  origin: EventOrigin;
  dedupe_key: string;
}

export function parseBremenEventsHtml(
  html: string,
  sourceUrl: URL,
  fetchedAt: string,
): SourceOutcome<ExternalImpact[]> {
  const $ = load(html);
  const warnings: SourceWarning[] = [];
  const candidates: ParsedEventCandidate[] = [];

  for (const rawScript of $('script[type="application/ld+json"]').toArray()) {
    const payload = $(rawScript).text();
    const events = parseJsonLdEvents(payload);

    for (const rawEvent of events) {
      const candidate = toJsonLdCandidate(rawEvent, sourceUrl, fetchedAt);

      if (candidate === undefined) {
        warnings.push(
          warning(
            'bremen_events',
            'MISSING_EFFECTIVE_DATE',
            `Skipping Bremen event without usable start date: ${stringValue(rawEvent.name) || 'unknown'}`,
            {
              occurredAt: fetchedAt,
              retryable: false,
            },
          ),
        );
        continue;
      }

      candidates.push(candidate);
    }
  }

  for (const element of $(
    'article, .event-card, [data-event-card]',
  ).toArray()) {
    const candidate = toHtmlCandidate($, element, sourceUrl, fetchedAt);

    if (candidate === undefined) {
      continue;
    }

    candidates.push(candidate);
  }

  return {
    data: deduplicateCandidates(candidates).map(stripOrigin),
    sources: [
      {
        source: 'bremen_events',
        fetched_at: fetchedAt,
        age_seconds: 0,
        stale: false,
      },
    ],
    warnings,
  };
}

function parseJsonLdEvents(payload: string): JsonLdEvent[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return [];
  }

  return flattenJsonLd(parsed)
    .filter(isRecord)
    .filter((value): value is JsonLdEvent => isEventType(value['@type']));
}

function flattenJsonLd(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenJsonLd(entry));
  }

  if (!isRecord(value)) {
    return [];
  }

  const graph = value['@graph'];

  return [value, ...flattenJsonLd(graph)];
}

function toJsonLdCandidate(
  rawEvent: JsonLdEvent,
  sourceUrl: URL,
  fetchedAt: string,
): ParsedEventCandidate | undefined {
  const title = normalizeWhitespace(stringValue(rawEvent.name));
  const startsAt = normalizeEventDate(stringValue(rawEvent.startDate), false);
  const endsAt = normalizeEventDate(
    stringValue(rawEvent.endDate),
    true,
    startsAt,
  );

  if (title === '' || startsAt === undefined) {
    return undefined;
  }

  const absoluteUrl = new URL(
    stringValue(rawEvent.url) || sourceUrl.toString(),
    sourceUrl,
  );
  const location = locationText(rawEvent.location);
  const summary = buildEventSummary(title, location);
  const contentHash = sha256Text([title, startsAt, endsAt, location].join('|'));

  return {
    id: stableId('bremen_events', absoluteUrl.toString(), title, contentHash),
    title,
    summary,
    ...(location === '' ? {} : { details: location }),
    corridor_ids: [],
    starts_at: startsAt,
    ...(endsAt === undefined ? {} : { ends_at: endsAt }),
    category: 'event',
    severity: /festival|konzert|woche/iu.test(title) ? 'moderate' : 'low',
    provenance: {
      source: 'bremen_events',
      sourceUrl: absoluteUrl.toString(),
      fetchedAt: fetchedAt,
      contentHash,
    },
    origin: 'jsonld',
    dedupe_key: dedupeKey(title, startsAt, endsAt, location),
  };
}

function toHtmlCandidate(
  $: ReturnType<typeof load>,
  element: Parameters<ReturnType<typeof load>>[0],
  sourceUrl: URL,
  fetchedAt: string,
): ParsedEventCandidate | undefined {
  const article = $(element);
  const link = article.find('a[href]').first();
  const title = normalizeWhitespace(link.text() || article.find('h2').text());
  const timeElements = article.find('time').toArray();
  const startRaw =
    timeElements[0] === undefined
      ? ''
      : ($(timeElements[0]).attr('datetime') ?? '');
  const endRaw =
    timeElements[1] === undefined
      ? ''
      : ($(timeElements[1]).attr('datetime') ?? '');
  const startsAt = normalizeEventDate(startRaw, false);
  const endsAt = normalizeEventDate(endRaw, true, startsAt);

  if (title === '' || startsAt === undefined) {
    return undefined;
  }

  const absoluteUrl = new URL(
    link.attr('href') ?? sourceUrl.toString(),
    sourceUrl,
  );
  const location = normalizeWhitespace(
    article.find('.location').first().text() ||
      article.find('[data-location]').first().text(),
  );
  const summary = normalizeWhitespace(
    article.find('.summary').first().text() ||
      buildEventSummary(title, location),
  );
  const contentHash = sha256Text(
    [title, startsAt, endsAt, location, summary].join('|'),
  );

  return {
    id: stableId('bremen_events', absoluteUrl.toString(), title, contentHash),
    title,
    summary,
    ...(location === '' ? {} : { details: location }),
    corridor_ids: [],
    starts_at: startsAt,
    ...(endsAt === undefined ? {} : { ends_at: endsAt }),
    category: 'event',
    severity: /festival|konzert|woche/iu.test(title) ? 'moderate' : 'low',
    provenance: {
      source: 'bremen_events',
      sourceUrl: absoluteUrl.toString(),
      fetchedAt: fetchedAt,
      contentHash,
    },
    origin: 'html',
    dedupe_key: dedupeKey(title, startsAt, endsAt, location),
  };
}

function deduplicateCandidates(
  candidates: ParsedEventCandidate[],
): ParsedEventCandidate[] {
  const deduplicated = new Map<string, ParsedEventCandidate>();

  for (const candidate of candidates) {
    const existing = deduplicated.get(candidate.dedupe_key);

    if (
      existing === undefined ||
      EVENT_DETAIL_PRIORITY[candidate.origin] <
        EVENT_DETAIL_PRIORITY[existing.origin]
    ) {
      deduplicated.set(candidate.dedupe_key, candidate);
    }
  }

  return [...deduplicated.values()];
}

function stripOrigin(candidate: ParsedEventCandidate): ExternalImpact {
  return {
    id: candidate.id,
    title: candidate.title,
    summary: candidate.summary,
    ...(candidate.details === undefined ? {} : { details: candidate.details }),
    corridor_ids: candidate.corridor_ids,
    ...(candidate.starts_at === undefined
      ? {}
      : { starts_at: candidate.starts_at }),
    ...(candidate.ends_at === undefined ? {} : { ends_at: candidate.ends_at }),
    category: candidate.category,
    severity: candidate.severity,
    provenance: candidate.provenance,
  };
}

function normalizeEventDate(
  value: string,
  endOfDay: boolean,
  fallbackStart?: string,
): string | undefined {
  const trimmed = normalizeWhitespace(value);

  if (trimmed === '') {
    return fallbackStart;
  }

  if (/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) {
    const [yearText, monthText, dayText] = trimmed.split('-');

    return toBerlinIso(
      Number(yearText),
      Number(monthText),
      Number(dayText),
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 999 : 0,
    );
  }

  const parsed = Date.parse(trimmed);

  if (Number.isNaN(parsed)) {
    return fallbackStart;
  }

  return new Date(parsed).toISOString();
}

function toBerlinIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): string {
  return new Date(
    new TZDate(
      year,
      month - 1,
      day,
      hour,
      minute,
      second,
      millisecond,
      BERLIN_TIMEZONE,
    ).getTime(),
  ).toISOString();
}

function buildEventSummary(title: string, location: string): string {
  return location === '' ? title : `${title} at ${location}`;
}

function dedupeKey(
  title: string,
  startsAt: string,
  endsAt: string | undefined,
  location: string,
): string {
  void location;

  return [normalizeKey(title), startsAt, endsAt ?? ''].join('|');
}

function locationText(value: unknown): string {
  if (!isRecord(value)) {
    return '';
  }

  const name = stringValue(value.name);
  const address = isRecord(value.address)
    ? [
        stringValue(value.address.name),
        stringValue(value.address.streetAddress),
        stringValue(value.address.addressLocality),
      ]
    : [];

  return normalizeWhitespace([name, ...address].filter(Boolean).join(', '));
}

function stableId(
  source: 'bremen_events',
  sourceUrl: string,
  title: string,
  contentHash: string,
): string {
  return sha256Text([source, sourceUrl, title, contentHash].join('|')).slice(
    0,
    24,
  );
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function normalizeKey(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/ß/gu, 'ss')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isEventType(value: unknown): boolean {
  if (typeof value === 'string') {
    return value === 'Event';
  }

  return Array.isArray(value) && value.some((entry) => entry === 'Event');
}

interface JsonLdEvent extends Record<string, unknown> {
  '@type'?: unknown;
  name?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  url?: unknown;
  location?: unknown;
}
