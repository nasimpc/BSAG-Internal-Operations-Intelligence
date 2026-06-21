import { TZDate } from '@date-fns/tz';
import { load } from 'cheerio';

import type { ServiceNotice, SourceWarning } from '../domain/models.js';
import { type SourceOutcome, warning } from '../domain/result.js';
import { sha256Text } from '../shared/hash.js';

const BERLIN_TIMEZONE = 'Europe/Berlin';
const LINE_TOKEN_PATTERN = /\b(?:N?\d+[A-Z]?)\b/g;
const DATE_ONLY_PATTERN = /(\d{2})\.(\d{2})\.(\d{4})/gu;

export const BSAG_OPERATIONAL_TERMS = [
  'umleitung',
  'ersatzverkehr',
  'haltestelle',
  'nicht bedient',
  'baumaßnahme',
  'bauarbeiten',
  'gesperrt',
  'einschränkung',
  'echtzeitdaten',
  'fahrgastinfos',
  'fahrgastinformationen',
  'wartungsarbeiten',
] as const;

const BSAG_GLOBAL_OPERATIONAL_TERMS = [
  'einschränkung',
  'echtzeitdaten',
  'fahrgastinfos',
  'fahrgastinformationen',
  'wartungsarbeiten',
  'sommerzeit',
  'fahrplan',
] as const;

export function parseBsagNoticesHtml(
  html: string,
  sourceUrl: URL,
  fetchedAt: string,
): SourceOutcome<ServiceNotice[]> {
  const $ = load(html);
  const notices: ServiceNotice[] = [];

  for (const element of $(
    'article, .article[itemtype*="Article"], .news-list-view .article',
  ).toArray()) {
    const article = $(element);
    const link = article.find('a[href]').first();
    const title = firstNonEmptyText(
      article.find('[itemprop="headline"]').last().text(),
      article.find('h2').last().text(),
      link.attr('title') ?? '',
      link.text(),
    );
    const paragraphs = extractParagraphs($, element);
    const body = normalizeWhitespace(article.text());
    const stopNames = splitStops(extractLabelledText(paragraphs, 'Betroffene'));
    const lines = extractLineTokens(title, paragraphs);
    const hasSpecificScope = lines.length > 0 || stopNames.length > 0;

    if (
      title.length === 0 ||
      !isOperationalCandidate(`${title} ${body}`) ||
      (!hasSpecificScope && !isGlobalOperationalCandidate(`${title} ${body}`))
    ) {
      continue;
    }

    const absoluteUrl = new URL(
      firstNonEmptyText(link.attr('href') ?? '', sourceUrl.toString()),
      sourceUrl,
    );
    const summary = firstUnlabelledParagraph(paragraphs) || title;
    const validity = parseDateWindow(extractLabelledText(paragraphs, 'Dauer'));
    const publishedAt = normalizePublishedAt(
      article.find('time').attr('datetime'),
    );
    const contentHash = sha256Text(
      [title, summary, validity.validFrom, validity.validTo, body].join('|'),
    );

    notices.push({
      id: stableId('bsag', absoluteUrl.toString(), title, contentHash),
      title,
      summary,
      details: body,
      lines,
      stop_names: stopNames,
      ...(validity.validFrom === undefined
        ? {}
        : { valid_from: validity.validFrom }),
      ...(validity.validTo === undefined ? {} : { valid_to: validity.validTo }),
      severity: severityFromText(`${title} ${body}`),
      provenance: {
        source: 'bsag',
        sourceUrl: absoluteUrl.toString(),
        fetchedAt: fetchedAt,
        ...(publishedAt === undefined ? {} : { publishedAt: publishedAt }),
        contentHash,
      },
    });
  }

  const warnings: SourceWarning[] =
    notices.length === 0 && pageContainsOperationalNoticeText($)
      ? [
          warning(
            'bsag',
            'PARSER_NO_RECORDS',
            'No candidate BSAG notice records were found in a page that appears to contain operational notices',
            {
              occurredAt: fetchedAt,
              retryable: false,
            },
          ),
        ]
      : [];

  return {
    data: notices,
    sources: [
      {
        source: 'bsag',
        fetched_at: fetchedAt,
        age_seconds: 0,
        stale: false,
      },
    ],
    warnings,
  };
}

function parseDateWindow(durationText: string): {
  validFrom?: string;
  validTo?: string;
} {
  const matches = [...durationText.matchAll(DATE_ONLY_PATTERN)];

  if (matches.length < 2) {
    return {};
  }

  const [start, end] = matches;

  if (start === undefined || end === undefined) {
    return {};
  }

  return {
    validFrom: toBerlinIso(start, false),
    validTo: toBerlinIso(end, true),
  };
}

function toBerlinIso(match: RegExpMatchArray, endOfDay: boolean): string {
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  return new Date(
    new TZDate(
      year,
      month - 1,
      day,
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 999 : 0,
      BERLIN_TIMEZONE,
    ).getTime(),
  ).toISOString();
}

function firstUnlabelledParagraph(paragraphs: string[]) {
  const summaryParagraph = paragraphs.find(
    (text) => !/^(Dauer|Linie|Betroffene):/iu.test(text),
  );

  return summaryParagraph ?? '';
}

function extractLabelledText(paragraphs: string[], label: string): string {
  const prefix = `${label}:`;
  const paragraph = paragraphs.find((value) =>
    value.toLowerCase().startsWith(prefix.toLowerCase()),
  );

  if (paragraph === undefined) {
    return '';
  }

  return normalizeWhitespace(paragraph.slice(prefix.length));
}

function isOperationalCandidate(value: string): boolean {
  const normalized = value.toLowerCase();

  return BSAG_OPERATIONAL_TERMS.some((term) => normalized.includes(term));
}

function isGlobalOperationalCandidate(value: string): boolean {
  const normalized = value.toLowerCase();

  return BSAG_GLOBAL_OPERATIONAL_TERMS.some((term) =>
    normalized.includes(term),
  );
}

function extractLineTokens(title: string, paragraphs: string[]): string[] {
  const candidates = [
    title,
    ...paragraphs.filter(
      (text) =>
        /\bLinie(?:n)?\b/iu.test(text) && !/^(Dauer|Betroffene):/iu.test(text),
    ),
  ];

  return [
    ...new Set(candidates.flatMap((value) => extractLineTokensFromText(value))),
  ];
}

function extractLineTokensFromText(value: string): string[] {
  const prefix = value.includes(':') ? (value.split(':')[0] ?? value) : value;
  const lineMentions = [...prefix.matchAll(/\bLinie(?:n)?\s*:?\s*([^:]+)/giu)];

  if (lineMentions.length === 0) {
    return value.match(LINE_TOKEN_PATTERN) ?? [];
  }

  return lineMentions.flatMap(
    (match) => match[1]?.match(LINE_TOKEN_PATTERN) ?? [],
  );
}

function extractParagraphs(
  $: ReturnType<typeof load>,
  element: Parameters<ReturnType<typeof load>>[0],
): string[] {
  return $(element)
    .find('p')
    .toArray()
    .map((paragraph) => normalizeWhitespace($(paragraph).text()))
    .filter((text) => text.length > 0);
}

function splitStops(value: string): string[] {
  return dedupeStrings(
    value
      .split(/[;,]/u)
      .map((entry) => normalizeWhitespace(entry))
      .filter((entry) => entry.length > 0),
  );
}

function normalizePublishedAt(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const [yearText, monthText, dayText] = value.split('-');

    return datePartsToBerlinIso(
      Number(dayText),
      Number(monthText),
      Number(yearText),
    );
  }

  const parsed = Date.parse(value);

  if (Number.isNaN(parsed)) {
    return undefined;
  }

  return new Date(parsed).toISOString();
}

function datePartsToBerlinIso(
  day: number,
  month: number,
  year: number,
): string {
  return new Date(
    new TZDate(year, month - 1, day, 0, 0, 0, 0, BERLIN_TIMEZONE).getTime(),
  ).toISOString();
}

function pageContainsOperationalNoticeText($: ReturnType<typeof load>): boolean {
  const text = normalizeWhitespace($('main, body').text());

  return (
    isOperationalCandidate(text) &&
    (hasLineToken(text) || isGlobalOperationalCandidate(text))
  );
}

function hasLineToken(value: string): boolean {
  return /\b(?:N?\d+[A-Z]?)\b/u.test(value);
}

function severityFromText(value: string): ServiceNotice['severity'] {
  if (/gesperrt|nicht bedient|entfällt/iu.test(value)) {
    return 'critical';
  }

  if (
    /umleitung|ersatzverkehr|baumaßnahme|bauarbeiten|wartungsarbeiten|einschränkung/iu.test(
      value,
    )
  ) {
    return 'warning';
  }

  return 'info';
}

function firstNonEmptyText(...values: string[]): string {
  return (
    values
      .map((entry) => normalizeWhitespace(entry))
      .find((entry) => entry.length > 0) ?? ''
  );
}

function dedupeStrings(values: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

function stableId(
  source: string,
  absoluteUrl: string,
  title: string,
  contentHash: string,
): string {
  return sha256Text([source, absoluteUrl, title, contentHash].join('|')).slice(
    0,
    24,
  );
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}
