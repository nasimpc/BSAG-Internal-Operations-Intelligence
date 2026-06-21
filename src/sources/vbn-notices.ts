import { TZDate } from '@date-fns/tz';
import { load } from 'cheerio';

import type { ServiceNotice, SourceWarning } from '../domain/models.js';
import { type SourceOutcome, warning } from '../domain/result.js';
import { sha256Text } from '../shared/hash.js';

const BERLIN_TIMEZONE = 'Europe/Berlin';
const LINE_TOKEN_PATTERN = /\b(?:N?\d+[A-Z]?)\b/g;
const DATE_WITH_TIME_PATTERN =
  /(\d{1,2})\.(\d{1,2})\.(\d{4}),\s*(\d{1,2}):(\d{2})\s*Uhr/gu;
const DATE_ONLY_PATTERN = /(\d{1,2})\.(\d{1,2})\.(\d{4})/gu;
const GERMAN_MONTH_PATTERN =
  '(Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)';
const VBN_OPERATIONAL_TERMS = [
  'umleitung',
  'baustelle',
  'bauarbeiten',
  'gleisarbeiten',
  'haltestelle',
  'haltestellenausfall',
  'ersatzverkehr',
  'sperrung',
  'gesperrt',
  'nicht bedient',
  'fahrplanänderung',
  'vollsperrung',
] as const;

export function parseVbnNoticesHtml(
  html: string,
  sourceUrl: URL,
  fetchedAt: string,
): SourceOutcome<ServiceNotice[]> {
  const $ = load(html);
  const notices: ServiceNotice[] = [];
  const warnings: SourceWarning[] = [];

  for (const element of $('article').toArray()) {
    const parsed = parseArticleNotice($, element, sourceUrl, fetchedAt);

    if (parsed.notice !== undefined) {
      notices.push(parsed.notice);
    }

    if (parsed.warning !== undefined) {
      warnings.push(parsed.warning);
    }
  }

  for (const element of $('.co-accordion.card').toArray()) {
    const parsed = parseAccordionNotice($, element, sourceUrl, fetchedAt);

    if (parsed !== undefined) {
      notices.push(parsed);
    }
  }

  if (notices.length === 0 && pageContainsOperationalNoticeText($)) {
    warnings.push(
      warning(
        'vbn_notices',
        'PARSER_NO_RECORDS',
        'No candidate VBN notice records were found in a page that appears to contain operational notices',
        {
          occurredAt: fetchedAt,
          retryable: false,
        },
      ),
    );
  }

  return {
    data: deduplicateNotices(notices),
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

function parseArticleNotice(
  $: ReturnType<typeof load>,
  element: Parameters<ReturnType<typeof load>>[0],
  sourceUrl: URL,
  fetchedAt: string,
): { notice?: ServiceNotice; warning?: SourceWarning } {
  const article = $(element);
  const link = article.find('a[href]').first();
  const title = firstNonEmptyText(
    article.find('[itemprop="headline"]').last().text(),
    article.find('h2').last().text(),
    link.attr('title') ?? '',
    link.text(),
  );
  const paragraphs = extractParagraphs($, element);

  if (title.length === 0) {
    return {};
  }

  const durationText = extractLabelledText(paragraphs, 'Dauer');
  const lineText = `${extractLabelledText(paragraphs, 'Linie')} ${title}`;
  const stopText = extractLabelledText(paragraphs, 'Betroffene');
  const lines = extractLineTokens(lineText);

  if (lines.length === 0) {
    return {};
  }

  const summary = firstUnlabelledParagraph(paragraphs) || title;
  const validity = parseValidityWindow(durationText, {
    warnWhenUnparsed: durationText.length > 0,
  });
  const absoluteUrl = new URL(
    firstNonEmptyText(link.attr('href') ?? '', sourceUrl.toString()),
    sourceUrl,
  );
  const stopNames = splitStops(stopText);
  const details = normalizeWhitespace(article.text());
  const contentHash = sha256Text(
    [title, summary, durationText, lines.join(','), stopNames.join(',')].join(
      '|',
    ),
  );

  return {
    notice: {
      id: stableId('vbn_notices', absoluteUrl.toString(), title, contentHash),
      title,
      summary,
      details,
      lines,
      stop_names: stopNames,
      ...(validity.validFrom === undefined
        ? {}
        : { valid_from: validity.validFrom }),
      ...(validity.validTo === undefined ? {} : { valid_to: validity.validTo }),
      severity: severityFromText(`${title} ${details}`),
      provenance: {
        source: 'vbn_notices',
        sourceUrl: absoluteUrl.toString(),
        fetchedAt: fetchedAt,
        contentHash,
      },
    },
    ...(validity.warning === undefined
      ? {}
      : {
          warning: warning(
            'vbn_notices',
            validity.warning,
            validity.message,
            {
              occurredAt: fetchedAt,
              retryable: false,
            },
          ),
        }),
  };
}

function parseAccordionNotice(
  $: ReturnType<typeof load>,
  element: Parameters<ReturnType<typeof load>>[0],
  sourceUrl: URL,
  fetchedAt: string,
): ServiceNotice | undefined {
  const card = $(element);
  const title = firstNonEmptyText(
    card.find('.card-header button').first().text(),
    card.find('.card-header h5').first().text(),
  );

  if (title.length === 0) {
    return undefined;
  }

  const body = card.find('.card-body').first();
  const paragraphs = extractParagraphs($, body.get(0) ?? element);
  const details = normalizeWhitespace(body.text());
  const lines = extractLineTokens(title);

  if (lines.length === 0 || !isOperationalCandidate(`${title} ${details}`)) {
    return undefined;
  }

  const summary = firstUnlabelledParagraph(paragraphs) || title;
  const stopNames = extractListStops($, body.get(0) ?? element);
  const validity = parseValidityWindow(
    [title, ...paragraphs].join(' '),
    { warnWhenUnparsed: false },
  );
  const cardId = card.parent('.accordion').attr('id') ?? card.attr('id') ?? '';
  const absoluteUrl = new URL(
    cardId.length === 0 ? sourceUrl.toString() : `#${cardId}`,
    sourceUrl,
  );
  const contentHash = sha256Text(
    [
      title,
      summary,
      details,
      lines.join(','),
      stopNames.join(','),
      validity.validFrom,
      validity.validTo,
    ].join('|'),
  );

  return {
    id: stableId('vbn_notices', absoluteUrl.toString(), title, contentHash),
    title,
    summary,
    details,
    lines,
    stop_names: stopNames,
    ...(validity.validFrom === undefined
      ? {}
      : { valid_from: validity.validFrom }),
    ...(validity.validTo === undefined ? {} : { valid_to: validity.validTo }),
    severity: severityFromText(`${title} ${details}`),
    provenance: {
      source: 'vbn_notices',
      sourceUrl: absoluteUrl.toString(),
      fetchedAt: fetchedAt,
      contentHash,
    },
  };
}

function parseValidityWindow(
  durationText: string,
  options: {
    warnWhenUnparsed: boolean;
  },
): {
  validFrom?: string;
  validTo?: string;
  warning?: 'MISSING_EFFECTIVE_DATE';
  message: string;
} {
  const normalized = normalizeWhitespace(durationText);

  if (normalized.length === 0) {
    return {
      message: 'No effective interval text was present',
    };
  }

  const withTime = [...durationText.matchAll(DATE_WITH_TIME_PATTERN)];

  if (withTime.length >= 2) {
    const [start, end] = withTime;

    if (start === undefined || end === undefined) {
      return {
        warning: 'MISSING_EFFECTIVE_DATE',
        message: `Could not parse a complete effective interval from "${normalized}"`,
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
        message: `Could not parse a complete effective interval from "${normalized}"`,
      };
    }

    return {
      validFrom: toBerlinIso(start, false, true),
      validTo: toBerlinIso(end, true, true),
      message: 'Parsed effective interval',
    };
  }

  if (dateOnly.length === 1 && /\bab\b/iu.test(durationText)) {
    const [start] = dateOnly;

    if (start !== undefined) {
      return {
        validFrom: toBerlinIso(start, false, true),
        message: 'Parsed open-ended effective interval',
      };
    }
  }

  const germanRange = parseGermanDateRange(normalized);

  if (germanRange !== undefined) {
    return germanRange;
  }

  const germanStart = parseGermanStartDate(normalized);

  if (germanStart !== undefined) {
    return {
      validFrom: germanStart,
      message: 'Parsed open-ended effective interval',
    };
  }

  const germanEnd = parseGermanEndDate(normalized);

  if (germanEnd !== undefined) {
    return {
      validTo: germanEnd,
      message: 'Parsed effective interval end',
    };
  }

  if (!options.warnWhenUnparsed) {
    return {
      message: 'No effective interval could be parsed',
    };
  }

  return {
    warning: 'MISSING_EFFECTIVE_DATE',
    message: `Could not parse a complete effective interval from "${normalized}"`,
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

function parseGermanDateRange(value: string):
  | {
      validFrom?: string;
      validTo?: string;
      message: string;
    }
  | undefined {
  const sameMonthPattern = new RegExp(
    `(\\d{1,2})\\.\\s*(?:bis|-)\\s*(?:voraussichtlich\\s*)?(\\d{1,2})\\.\\s*${GERMAN_MONTH_PATTERN}\\s*(\\d{4})`,
    'iu',
  );
  const sameMonthMatch = sameMonthPattern.exec(value);

  if (sameMonthMatch !== null) {
    const [, startDay, endDay, monthName, year] = sameMonthMatch;
    const month = monthNumber(monthName);

    if (
      startDay !== undefined &&
      endDay !== undefined &&
      month !== undefined &&
      year !== undefined
    ) {
      return {
        validFrom: datePartsToBerlinIso(Number(startDay), month, Number(year)),
        validTo: datePartsToBerlinIso(
          Number(endDay),
          month,
          Number(year),
          true,
        ),
        message: 'Parsed effective interval',
      };
    }
  }

  const monthRangePattern = new RegExp(
    `(\\d{1,2})\\.\\s*${GERMAN_MONTH_PATTERN}\\s*(\\d{4})?\\b.{0,100}?\\bbis\\b\\s*(?:voraussichtlich\\s*)?(\\d{1,2})\\.\\s*${GERMAN_MONTH_PATTERN}\\s*(\\d{4})`,
    'iu',
  );
  const monthRangeMatch = monthRangePattern.exec(value);

  if (monthRangeMatch !== null) {
    const [
      ,
      startDay,
      startMonthName,
      startYear,
      endDay,
      endMonthName,
      endYear,
    ] = monthRangeMatch;
    const startMonth = monthNumber(startMonthName);
    const endMonth = monthNumber(endMonthName);

    if (
      startDay !== undefined &&
      startMonth !== undefined &&
      endDay !== undefined &&
      endMonth !== undefined &&
      endYear !== undefined
    ) {
      const resolvedStartYear = Number(startYear ?? endYear);

      return {
        validFrom: datePartsToBerlinIso(
          Number(startDay),
          startMonth,
          resolvedStartYear,
        ),
        validTo: datePartsToBerlinIso(
          Number(endDay),
          endMonth,
          Number(endYear),
          true,
        ),
        message: 'Parsed effective interval',
      };
    }
  }

  return undefined;
}

function parseGermanStartDate(value: string): string | undefined {
  const startPattern = new RegExp(
    `\\bab\\s+(\\d{1,2})\\.\\s*${GERMAN_MONTH_PATTERN}\\s*(\\d{4})`,
    'iu',
  );
  const match = startPattern.exec(value);

  if (match === null) {
    return undefined;
  }

  const [, day, monthName, year] = match;
  const month = monthNumber(monthName);

  if (day === undefined || month === undefined || year === undefined) {
    return undefined;
  }

  return datePartsToBerlinIso(Number(day), month, Number(year));
}

function parseGermanEndDate(value: string): string | undefined {
  const endPattern = new RegExp(
    `\\bbis\\s+(?:voraussichtlich\\s*)?(\\d{1,2})\\.\\s*${GERMAN_MONTH_PATTERN}\\s*(\\d{4})`,
    'iu',
  );
  const match = endPattern.exec(value);

  if (match === null) {
    return undefined;
  }

  const [, day, monthName, year] = match;
  const month = monthNumber(monthName);

  if (day === undefined || month === undefined || year === undefined) {
    return undefined;
  }

  return datePartsToBerlinIso(Number(day), month, Number(year), true);
}

function datePartsToBerlinIso(
  day: number,
  month: number,
  year: number,
  endOfDay = false,
): string {
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

function monthNumber(value: string | undefined): number | undefined {
  switch (value?.toLowerCase()) {
    case 'januar':
      return 1;
    case 'februar':
      return 2;
    case 'märz':
    case 'maerz':
      return 3;
    case 'april':
      return 4;
    case 'mai':
      return 5;
    case 'juni':
      return 6;
    case 'juli':
      return 7;
    case 'august':
      return 8;
    case 'september':
      return 9;
    case 'oktober':
      return 10;
    case 'november':
      return 11;
    case 'dezember':
      return 12;
    default:
      return undefined;
  }
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
  const prefix = value.includes(':') ? (value.split(':')[0] ?? value) : value;
  const lineMentions = [...prefix.matchAll(/\bLinie(?:n)?\s*:?\s*([^:]+)/giu)];
  const candidates =
    lineMentions.length === 0
      ? (value.match(LINE_TOKEN_PATTERN) ?? [])
      : lineMentions.flatMap((match) => match[1]?.match(LINE_TOKEN_PATTERN) ?? []);

  return [...new Set(candidates)];
}

function extractListStops(
  $: ReturnType<typeof load>,
  element: Parameters<ReturnType<typeof load>>[0],
): string[] {
  return dedupeStrings(
    $(element)
      .find('li')
      .toArray()
      .map((item) => cleanStopName($(item).text()))
      .filter((item) => item.length > 0),
  );
}

function splitStops(value: string): string[] {
  return dedupeStrings(
    value
      .split(/[;,]/u)
      .map((entry) => cleanStopName(entry))
      .filter((entry) => entry.length > 0),
  );
}

function cleanStopName(value: string): string {
  return normalizeWhitespace(value)
    .replace(/\s*\((?:Linie|Linien)[^)]+\)/giu, '')
    .split(/[→>:]/u)[0]
    ?.replace(/\s+-\s+(?:stadt(?:ein|aus)wärts|Richtung)\b.*$/iu, '')
    .trim() ?? '';
}

function dedupeStrings(values: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = normalizeWhitespace(value);

    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped;
}

function deduplicateNotices(notices: ServiceNotice[]): ServiceNotice[] {
  const deduplicated = new Map<string, ServiceNotice>();

  for (const notice of notices) {
    const key = [
      normalizeKey(notice.title),
      notice.lines
        .map((line) => line.toUpperCase())
        .sort()
        .join(','),
      notice.valid_from ?? '',
      notice.valid_to ?? '',
    ].join('|');

    if (!deduplicated.has(key)) {
      deduplicated.set(key, notice);
    }
  }

  return [...deduplicated.values()];
}

function pageContainsOperationalNoticeText($: ReturnType<typeof load>): boolean {
  const text = normalizeWhitespace($('.root-contentbar, main, body').text());

  return hasLineToken(text) && isOperationalCandidate(text);
}

function hasLineToken(value: string): boolean {
  return /\b(?:N?\d+[A-Z]?)\b/u.test(value);
}

function isOperationalCandidate(value: string): boolean {
  const normalized = value.toLowerCase();

  return VBN_OPERATIONAL_TERMS.some((term) => normalized.includes(term));
}

function severityFromText(value: string): ServiceNotice['severity'] {
  if (
    /vollsperrung|gesperrt|nicht bedient|entfällt|ersatzverkehr/iu.test(value)
  ) {
    return 'critical';
  }

  if (/umleitung|baustelle|bauarbeiten|gleisarbeiten|sperrung/iu.test(value)) {
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

function normalizeKey(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/ß/gu, 'ss')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
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
