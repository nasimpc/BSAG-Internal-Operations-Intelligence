import { TZDate } from '@date-fns/tz';
import { load } from 'cheerio';

import type { ServiceNotice, SourceWarning } from '../domain/models.js';
import { type SourceOutcome, warning } from '../domain/result.js';
import { sha256Text } from '../shared/hash.js';

const BERLIN_TIMEZONE = 'Europe/Berlin';
const LINE_TOKEN_PATTERN = /\b(?:N?\d+[A-Z]?)\b/g;
const DATE_WITH_TIME_PATTERN =
  /(\d{2})\.(\d{2})\.(\d{4}),\s*(\d{2}):(\d{2})\s*Uhr/gu;
const DATE_ONLY_PATTERN = /(\d{2})\.(\d{2})\.(\d{4})/gu;

export function parseVbnNoticesHtml(
  html: string,
  sourceUrl: URL,
  fetchedAt: string,
): SourceOutcome<ServiceNotice[]> {
  const $ = load(html);
  const notices: ServiceNotice[] = [];
  const warnings: SourceWarning[] = [];

  for (const element of $('article').toArray()) {
    const article = $(element);
    const link = article.find('a').first();
    const title = normalizeWhitespace(link.text() || article.find('h2').text());
    const paragraphs = extractParagraphs($, element);

    if (title.length === 0) {
      continue;
    }

    const durationText = extractLabelledText(paragraphs, 'Dauer');
    const lineText = `${extractLabelledText(paragraphs, 'Linie')} ${title}`;
    const stopText = extractLabelledText(paragraphs, 'Betroffene');
    const summary = firstUnlabelledParagraph(paragraphs);
    const validity = parseValidityWindow(durationText, fetchedAt);

    if (validity.warning !== undefined) {
      warnings.push(
        warning('vbn_notices', validity.warning, validity.message, {
          occurredAt: fetchedAt,
          retryable: false,
        }),
      );
    }

    const lines = extractLineTokens(lineText);

    if (lines.length === 0) {
      continue;
    }

    const absoluteUrl = new URL(
      link.attr('href') ?? sourceUrl.toString(),
      sourceUrl,
    );
    const stopNames = splitStops(stopText);
    const contentHash = sha256Text(
      [title, summary, durationText, lines.join(','), stopNames.join(',')].join(
        '|',
      ),
    );

    notices.push({
      id: stableId('vbn_notices', absoluteUrl.toString(), title, contentHash),
      title,
      summary,
      details: normalizeWhitespace(article.text()),
      lines,
      stop_names: stopNames,
      ...(validity.validFrom === undefined
        ? {}
        : { valid_from: validity.validFrom }),
      ...(validity.validTo === undefined ? {} : { valid_to: validity.validTo }),
      severity: 'warning',
      provenance: {
        source: 'vbn_notices',
        sourceUrl: absoluteUrl.toString(),
        fetchedAt: fetchedAt,
        contentHash,
      },
    });
  }

  if (notices.length === 0) {
    warnings.push(
      warning(
        'vbn_notices',
        'PARSER_NO_RECORDS',
        'No candidate VBN notice records were found in the page',
        {
          occurredAt: fetchedAt,
          retryable: false,
        },
      ),
    );
  }

  return {
    data: notices,
    sources: [
      {
        source: 'vbn_notices',
        fetched_at: fetchedAt,
        age_seconds: 0,
        stale: false,
      },
    ],
    warnings,
  };
}

function parseValidityWindow(
  durationText: string,
  fetchedAt: string,
): {
  validFrom?: string;
  validTo?: string;
  warning?: 'MISSING_EFFECTIVE_DATE';
  message: string;
} {
  const withTime = [...durationText.matchAll(DATE_WITH_TIME_PATTERN)];

  if (withTime.length >= 2) {
    const [start, end] = withTime;

    if (start === undefined || end === undefined) {
      return {
        warning: 'MISSING_EFFECTIVE_DATE',
        message: `Could not parse a complete effective interval from "${durationText || fetchedAt}"`,
      };
    }

    return {
      validFrom: toBerlinIso(start, false),
      validTo: toBerlinIso(end, false),
      message: 'Parsed effective interval',
    };
  }

  const dateOnly = [...durationText.matchAll(DATE_ONLY_PATTERN)];

  if (dateOnly.length >= 2 && /bis|-/.test(durationText)) {
    const [start, end] = dateOnly;

    if (start === undefined || end === undefined) {
      return {
        warning: 'MISSING_EFFECTIVE_DATE',
        message: `Could not parse a complete effective interval from "${durationText || fetchedAt}"`,
      };
    }

    return {
      validFrom: toBerlinIso(start, false, true),
      validTo: toBerlinIso(end, true, true),
      message: 'Parsed effective interval',
    };
  }

  return {
    warning: 'MISSING_EFFECTIVE_DATE',
    message: `Could not parse a complete effective interval from "${durationText || fetchedAt}"`,
  };
}

function toBerlinIso(
  match: RegExpMatchArray,
  endOfDay: boolean,
  dateOnly = false,
): string {
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const hour = dateOnly ? (endOfDay ? 23 : 0) : Number(match[4] ?? '0');
  const minute = dateOnly ? (endOfDay ? 59 : 0) : Number(match[5] ?? '0');
  const second = endOfDay ? 59 : 0;
  const millisecond = endOfDay ? 999 : 0;

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

function firstUnlabelledParagraph(paragraphs: string[]) {
  const summaryParagraphs = paragraphs.filter(
    (text) => !/^(Dauer|Linie|Betroffene):/iu.test(text),
  );

  return summaryParagraphs[0] ?? '';
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

function extractLineTokens(value: string): string[] {
  return [...new Set(value.match(LINE_TOKEN_PATTERN) ?? [])];
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
