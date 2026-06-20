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
  'haltestelle',
  'nicht bedient',
  'baumaßnahme',
  'bauarbeiten',
  'gesperrt',
] as const;

export function parseBsagNoticesHtml(
  html: string,
  sourceUrl: URL,
  fetchedAt: string,
): SourceOutcome<ServiceNotice[]> {
  const $ = load(html);
  const notices: ServiceNotice[] = [];

  for (const element of $('article').toArray()) {
    const article = $(element);
    const link = article.find('a').first();
    const title = normalizeWhitespace(link.text() || article.find('h2').text());
    const paragraphs = extractParagraphs($, element);
    const body = normalizeWhitespace(article.text());
    const stopNames = splitStops(extractLabelledText(paragraphs, 'Betroffene'));
    const lines = extractLineTokens(title, paragraphs);

    if (
      title.length === 0 ||
      !isOperationalCandidate(`${title} ${body}`) ||
      (lines.length === 0 && stopNames.length === 0)
    ) {
      continue;
    }

    const absoluteUrl = new URL(link.attr('href') ?? sourceUrl.toString(), sourceUrl);
    const summary = firstUnlabelledParagraph(paragraphs);
    const validity = parseDateWindow(extractLabelledText(paragraphs, 'Dauer'));
    const publishedAt = article.find('time').attr('datetime');
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
      severity: 'warning',
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
    notices.length === 0
      ? [
          warning(
            'bsag',
            'PARSER_NO_RECORDS',
            'No candidate BSAG notice records were found in the page',
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

function extractLineTokens(title: string, paragraphs: string[]): string[] {
  const candidates = [
    title,
    ...paragraphs.filter(
      (text) =>
        /\bLinie(?:n)?\b/iu.test(text) && !/^(Dauer|Betroffene):/iu.test(text),
    ),
  ];

  return [
    ...new Set(candidates.flatMap((value) => value.match(LINE_TOKEN_PATTERN) ?? [])),
  ];
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
  return value
    .split(/[;,]/u)
    .map((entry) => normalizeWhitespace(entry))
    .filter((entry) => entry.length > 0);
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
