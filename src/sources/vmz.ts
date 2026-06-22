import { TZDate } from '@date-fns/tz';
import { load } from 'cheerio';
import { XMLParser } from 'fast-xml-parser';

import type {
  ExternalImpact,
  Provenance,
  SourceWarning,
} from '../domain/models.js';
import { type SourceOutcome, warning } from '../domain/result.js';
import type { Clock } from '../shared/clock.js';
import { sha256Text } from '../shared/hash.js';
import type {
  BinaryFetchPolicy,
  SourceHttpClient,
  TextFetchPolicy,
} from './http-client.js';

const BERLIN_TIMEZONE = 'Europe/Berlin';
const TEXT_FETCH_POLICY: TextFetchPolicy = {
  expectedTypes: [
    'application/rss+xml',
    'application/xml',
    'application/xhtml+xml',
    'text/html',
    'text/plain',
    'text/xml',
  ],
  maxBytes: 2_000_000,
  timeoutMs: 10_000,
};
const PDF_FETCH_POLICY: BinaryFetchPolicy = {
  expectedTypes: ['application/pdf'],
  maxBytes: 10_000_000,
  timeoutMs: 20_000,
};
const MAX_PDF_PAGES = 20;
const VMZ_FIELD_LABELS = new Set([
  'Ort',
  'Lage',
  'Richtung',
  'Beschreibung',
  'Grund',
  'Zeitraum',
  'Im Internet',
  'Baubeginn',
  'Bauende',
]);
const GERMAN_MONTHS = new Map<string, number>([
  ['januar', 1],
  ['februar', 2],
  ['maerz', 3],
  ['marz', 3],
  ['april', 4],
  ['mai', 5],
  ['juni', 6],
  ['juli', 7],
  ['august', 8],
  ['september', 9],
  ['oktober', 10],
  ['november', 11],
  ['dezember', 12],
]);

interface RssEnvelope {
  rss?: {
    channel?: {
      item?: unknown;
    };
  };
}

interface RssItem {
  title?: unknown;
  link?: unknown;
  description?: unknown;
  pubDate?: unknown;
  ['content:encoded']?: unknown;
}

export interface VmzRoadworkRecord {
  id: string;
  kind: 'roadwork' | 'detour';
  title: string;
  summary: string;
  location_terms: string[];
  starts_at?: string;
  ends_at?: string;
  severity: ExternalImpact['severity'];
  provenance: Provenance;
}

export interface VmzSourceOptions {
  client: Pick<SourceHttpClient, 'getText' | 'getBytes'>;
  clock: Clock;
  currentUrl: URL;
  overviewUrl: URL;
  previewUrl: URL;
  rssUrl: URL;
  extractPdfText?: (bytes: Uint8Array) => Promise<string>;
}

interface PdfJsPage {
  getTextContent(): Promise<{
    items: Array<{
      str?: string;
      transform?: number[];
    }>;
  }>;
}

interface PdfJsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfJsPage>;
}

interface PdfJsLoadingTask {
  promise: Promise<PdfJsDocument>;
}

interface PdfJsModule {
  getDocument(input: { data: Uint8Array }): PdfJsLoadingTask;
}

interface ParsedVmzRecordBlock {
  fields: Map<string, string>;
  bodyLines: string[];
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: false,
  trimValues: true,
});

export class VmzSource {
  readonly #client: Pick<SourceHttpClient, 'getText' | 'getBytes'>;
  readonly #clock: Clock;
  readonly #currentUrl: URL;
  readonly #overviewUrl: URL;
  readonly #previewUrl: URL;
  readonly #rssUrl: URL;
  readonly #extractPdfText: (bytes: Uint8Array) => Promise<string>;

  constructor(options: VmzSourceOptions) {
    this.#client = options.client;
    this.#clock = options.clock;
    this.#currentUrl = new URL(options.currentUrl);
    this.#overviewUrl = new URL(options.overviewUrl);
    this.#previewUrl = new URL(options.previewUrl);
    this.#rssUrl = new URL(options.rssUrl);
    this.#extractPdfText = options.extractPdfText ?? defaultExtractPdfText;
  }

  async fetch(): Promise<SourceOutcome<ExternalImpact[]>> {
    const fetchedAt = this.#clock.now().toISOString();
    const warnings: SourceWarning[] = [];
    const impacts: ExternalImpact[] = [];

    const [rssResult, currentResult, previewResult, overviewResult] =
      await Promise.allSettled([
        this.#client.getText(this.#rssUrl, TEXT_FETCH_POLICY),
        this.#client.getText(this.#currentUrl, TEXT_FETCH_POLICY),
        this.#client.getText(this.#previewUrl, TEXT_FETCH_POLICY),
        this.#client.getText(this.#overviewUrl, TEXT_FETCH_POLICY),
      ]);

    if (rssResult.status === 'fulfilled') {
      const rssOutcome = parseVmzFeedXml(
        rssResult.value.body,
        rssResult.value.finalUrl,
        fetchedAt,
      );

      impacts.push(...rssOutcome.data);
      warnings.push(...rssOutcome.warnings);
    } else {
      warnings.push(
        warning(
          'vmz_rss',
          'SOURCE_FETCH_FAILED',
          `Failed to fetch VMZ RSS: ${describeError(rssResult.reason)}`,
          {
            occurredAt: fetchedAt,
            retryable: false,
          },
        ),
      );
    }

    const pdfUrls = new Set<string>();

    for (const htmlResult of [currentResult, previewResult, overviewResult]) {
      if (htmlResult.status === 'fulfilled') {
        for (const url of discoverVmzPdfUrls(
          htmlResult.value.body,
          htmlResult.value.finalUrl,
        )) {
          pdfUrls.add(url.toString());
        }

        continue;
      }

      warnings.push(
        warning(
          'vmz_web',
          'SOURCE_FETCH_FAILED',
          `Failed to fetch VMZ roadworks page: ${describeError(htmlResult.reason)}`,
          {
            occurredAt: fetchedAt,
            retryable: false,
          },
        ),
      );
    }

    for (const pdfUrl of [...pdfUrls].sort()) {
      try {
        const response = await this.#client.getBytes(
          new URL(pdfUrl),
          PDF_FETCH_POLICY,
        );
        const rawText = await this.#extractPdfText(response.body);
        const normalizedText = normalizePdfText(rawText);
        const provenance: Provenance = {
          source: 'vmz_pdf',
          sourceUrl: response.finalUrl.toString(),
          fetchedAt,
          contentHash: sha256Text(normalizedText),
        };

        impacts.push(
          ...parseVmzRoadworksText(normalizedText, provenance).map((record) =>
            toExternalImpact(record),
          ),
        );
      } catch (error) {
        warnings.push(
          warning(
            'vmz_pdf',
            'PDF_EXTRACT_FAILED',
            `Failed to extract VMZ PDF ${pdfUrl}: ${describeError(error)}`,
            {
              occurredAt: fetchedAt,
              retryable: false,
            },
          ),
        );
      }
    }

    return {
      data: deduplicateImpacts(impacts),
      sources: [
        {
          source: 'vmz_rss',
          fetched_at: fetchedAt,
          age_seconds: 0,
          stale: false,
        },
        {
          source: 'vmz_web',
          fetched_at: fetchedAt,
          age_seconds: 0,
          stale: false,
        },
        {
          source: 'vmz_pdf',
          fetched_at: fetchedAt,
          age_seconds: 0,
          stale: false,
        },
      ],
      warnings,
    };
  }
}

export function parseVmzFeedXml(
  xml: string,
  sourceUrl: URL,
  fetchedAt: string,
): SourceOutcome<ExternalImpact[]> {
  const parsed = xmlParser.parse(xml) as RssEnvelope;
  const rawItems = parsed.rss?.channel?.item;
  const items = Array.isArray(rawItems)
    ? rawItems
    : rawItems === undefined
      ? []
      : [rawItems];
  const impacts: ExternalImpact[] = [];
  const warnings: SourceWarning[] = [];

  for (const rawItem of items) {
    const item = isRssItem(rawItem) ? rawItem : undefined;
    const title = normalizeWhitespace(asString(item?.title));
    const link = asString(item?.link);
    const description = normalizeWhitespace(
      stripHtml(asString(item?.description)),
    );
    const content = normalizeWhitespace(
      stripHtml(asString(item?.['content:encoded'])),
    );
    const publishedAt = toIsoOrUndefined(asString(item?.pubDate));

    if (title === '' || link === '' || description === '') {
      warnings.push(
        warning(
          'vmz_rss',
          'PARSER_ITEM_INVALID',
          `Skipping malformed VMZ RSS item with title "${title || 'unknown'}"`,
          {
            occurredAt: fetchedAt,
            retryable: false,
          },
        ),
      );
      continue;
    }

    const absoluteUrl = new URL(link, sourceUrl);
    const details = normalizeWhitespace(
      [description, content].filter(Boolean).join(' '),
    );
    const category = /baustelle|sperr|umleitung/iu.test(`${title} ${details}`)
      ? 'roadworks'
      : 'incident';
    const severity = /vollsperrung|gesperrt/iu.test(`${title} ${details}`)
      ? 'high'
      : /stau|unfall|baustelle|spurverengung|umleitung/iu.test(
            `${title} ${details}`,
          )
        ? 'moderate'
        : 'low';
    const contentHash = sha256Text([title, details, publishedAt].join('|'));

    impacts.push({
      id: stableId('vmz_rss', absoluteUrl.toString(), title, contentHash),
      title,
      summary: description,
      details,
      corridor_ids: [],
      category,
      severity,
      provenance: {
        source: 'vmz_rss',
        sourceUrl: absoluteUrl.toString(),
        fetchedAt,
        ...(publishedAt === undefined ? {} : { publishedAt }),
        contentHash,
      },
    });
  }

  return {
    data: impacts,
    sources: [
      {
        source: 'vmz_rss',
        fetched_at: fetchedAt,
        age_seconds: 0,
        stale: false,
      },
    ],
    warnings,
  };
}

export function discoverVmzPdfUrls(html: string, baseUrl: URL): URL[] {
  const $ = load(html);
  const urls = new Map<string, URL>();

  for (const element of $('a[href]').toArray()) {
    const href = $(element).attr('href');
    const linkText = normalizeWhitespace($(element).text());

    if (href === undefined) {
      continue;
    }

    const isDirectPdf = /\.pdf(?:$|\?)/iu.test(href);
    const isDumpFilePdf =
      /(?:^|[?&])eID=dumpFile(?:&|$)/iu.test(href) &&
      looksLikePdfAnchorText(linkText);

    if (!isDirectPdf && !isDumpFilePdf) {
      continue;
    }

    const absoluteUrl = new URL(href, baseUrl);

    urls.set(absoluteUrl.toString(), absoluteUrl);
  }

  return [...urls.values()].sort((left, right) =>
    left.toString().localeCompare(right.toString()),
  );
}

export function normalizePdfText(text: string): string {
  return text
    .replace(/\r/gu, '')
    .replace(/(?<=\p{Letter})-\n(?=\p{Letter})/gu, '')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n[ \t]+/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n+\s*—\s*/gu, ' — ')
    .replace(/\s*—\s*/gu, ' — ')
    .replace(/\n{2,}/gu, '\n')
    .trim();
}

export function parseVmzRoadworksText(
  text: string,
  provenance: Provenance,
): VmzRoadworkRecord[] {
  const normalized = normalizePdfText(text);
  const parsedBlocks = parseVmzRecordBlocks(normalized);
  const structured = parsedBlocks.flatMap((block) => {
    const weekly = parseWeeklyVmzRecord(block, provenance);

    if (weekly !== undefined) {
      return [weekly];
    }

    const special = parseSpecialVmzRecord(block, provenance);

    return special === undefined ? [] : [special];
  });

  return structured.length > 0
    ? structured
    : parseLegacyVmzRoadworksText(normalized, provenance);
}

function parseVmzRecordBlocks(text: string): ParsedVmzRecordBlock[] {
  const blocks: ParsedVmzRecordBlock[] = [];
  let current: ParsedVmzRecordBlock | undefined;
  let currentField: string | undefined;

  for (const line of splitVmzLines(text)) {
    const fieldMatch = parseKnownFieldLine(line);

    if (fieldMatch !== undefined) {
      if (current === undefined) {
        current = {
          fields: new Map<string, string>(),
          bodyLines: [],
        };
      } else if (fieldMatch.label === 'Ort' && current.fields.has('Ort')) {
        blocks.push(current);
        current = {
          fields: new Map<string, string>(),
          bodyLines: [],
        };
      }

      currentField = fieldMatch.label;
      current.fields.set(
        fieldMatch.label,
        appendSegment(current.fields.get(fieldMatch.label), fieldMatch.value),
      );
      continue;
    }

    if (current === undefined) {
      continue;
    }

    if (currentField !== undefined) {
      const genericField = parseGenericFieldLine(line);

      if (genericField !== undefined) {
        currentField = undefined;
        current.bodyLines.push(line);
        continue;
      }

      current.fields.set(
        currentField,
        appendSegment(current.fields.get(currentField), line),
      );
      continue;
    }

    current.bodyLines.push(line);
  }

  if (current !== undefined) {
    blocks.push(current);
  }

  return blocks;
}

function parseWeeklyVmzRecord(
  block: ParsedVmzRecordBlock,
  provenance: Provenance,
): VmzRoadworkRecord | undefined {
  const location = block.fields.get('Ort');
  const context = block.fields.get('Lage');
  const description = block.fields.get('Beschreibung');
  const reason = block.fields.get('Grund');
  const period = block.fields.get('Zeitraum');

  if (
    location === undefined ||
    context === undefined ||
    description === undefined ||
    reason === undefined ||
    period === undefined
  ) {
    return undefined;
  }

  const direction = block.fields.get('Richtung');
  const bounds = parseVmzDateRange(period);
  const title = `${location} — ${description}`;
  const summary = normalizeWhitespace(
    [
      description,
      `Lage: ${context}.`,
      direction === undefined ? '' : `Richtung: ${direction}.`,
      `Grund: ${reason}.`,
      `Zeitraum: ${period}.`,
    ].join(' '),
  );
  const sourceUrl =
    resolveVmzFeatureUrl(block.fields.get('Im Internet'), provenance) ??
    provenance.sourceUrl;
  const contentHash = sha256Text(
    [
      title,
      summary,
      bounds?.startsAt ?? '',
      bounds?.endsAt ?? '',
      sourceUrl,
    ].join('|'),
  );

  return {
    id: stableId('vmz_pdf', sourceUrl, title, contentHash),
    kind: classifyVmzKind([description, reason, direction].join(' ')),
    title,
    summary,
    location_terms: uniqueStrings([location, context, direction]),
    ...(bounds?.startsAt === undefined ? {} : { starts_at: bounds.startsAt }),
    ...(bounds?.endsAt === undefined ? {} : { ends_at: bounds.endsAt }),
    severity: classifyVmzSeverity([title, summary].join(' ')),
    provenance: {
      ...provenance,
      sourceUrl,
      contentHash,
    },
  };
}

function parseSpecialVmzRecord(
  block: ParsedVmzRecordBlock,
  provenance: Provenance,
): VmzRoadworkRecord | undefined {
  const location = block.fields.get('Ort');
  const start = block.fields.get('Baubeginn');
  const end = block.fields.get('Bauende');

  if (location === undefined || start === undefined || end === undefined) {
    return undefined;
  }

  const narrativeLines = extractSpecialNarrativeLines(block.bodyLines);
  const headline = narrativeLines[0] ?? `${location} — Baustelle`;
  const reason = block.fields.get('Grund');
  const summary = normalizeWhitespace(
    [
      narrativeLines.slice(1).join(' '),
      reason === undefined ? '' : `Grund: ${reason}.`,
      `Baubeginn: ${start}.`,
      `Bauende: ${end}.`,
    ].join(' '),
  );
  const startsAt = parseVmzDateToIso(start, 'start');
  const endsAt = parseVmzDateToIso(end, 'end');
  const contentHash = sha256Text(
    [
      headline,
      summary,
      startsAt ?? '',
      endsAt ?? '',
      provenance.sourceUrl,
    ].join('|'),
  );

  return {
    id: stableId('vmz_pdf', provenance.sourceUrl, headline, contentHash),
    kind: classifyVmzKind([headline, summary].join(' ')),
    title: headline,
    summary,
    location_terms: [location],
    ...(startsAt === undefined ? {} : { starts_at: startsAt }),
    ...(endsAt === undefined ? {} : { ends_at: endsAt }),
    severity: classifyVmzSeverity([headline, summary].join(' ')),
    provenance: {
      ...provenance,
      contentHash,
    },
  };
}

function extractSpecialNarrativeLines(lines: string[]): string[] {
  const filtered = lines.filter(
    (line) =>
      !/^(?:Auskunft(?::|$)|An$|Presse\s*\/\s*Rundfunkanstalten$|Presse \/$|Presse$|Rundfunkanstalten$)/iu.test(
        line,
      ),
  );
  const publishedAtIndex = filtered.findIndex((line) =>
    /^[A-ZÄÖÜ][\p{Letter}\- ]+,\s+\d{1,2}\.\s+\p{Letter}+\s+\d{4}$/u.test(line),
  );
  const relevant =
    publishedAtIndex >= 0 ? filtered.slice(publishedAtIndex + 1) : filtered;
  const footerIndex = relevant.findIndex((line) =>
    /^(?:Pressekontakt|Ihr)$/iu.test(line),
  );

  return (footerIndex >= 0 ? relevant.slice(0, footerIndex) : relevant).filter(
    (line) => line.length > 0,
  );
}

function parseLegacyVmzRoadworksText(
  text: string,
  provenance: Provenance,
): VmzRoadworkRecord[] {
  return splitVmzLines(text).flatMap((line) => {
    const match =
      /^(?<location>.+?)\s+—\s+(?<description>.+?)\s+vom\s+(?<start>\d{2}\.\d{2}\.\d{4})\s+bis\s+(?<end>\d{2}\.\d{2}\.\d{4})$/u.exec(
        line,
      );

    if (match?.groups === undefined) {
      return [];
    }

    const { location, description, start, end } = match.groups;

    if (
      location === undefined ||
      description === undefined ||
      start === undefined ||
      end === undefined
    ) {
      return [];
    }

    const normalizedLocation = normalizeWhitespace(location);
    const normalizedDescription = normalizeWhitespace(description);
    const startsAt = berlinDateToIso(start, false);
    const endsAt = berlinDateToIso(end, true);
    const title = `${normalizedLocation} — ${normalizedDescription}`;
    const summary = `${normalizedDescription} from ${start} to ${end}`;
    const contentHash = sha256Text([title, startsAt, endsAt].join('|'));

    return [
      {
        id: stableId('vmz_pdf', provenance.sourceUrl, title, contentHash),
        kind: classifyVmzKind(normalizedDescription),
        title,
        summary,
        location_terms: [normalizedLocation],
        starts_at: startsAt,
        ends_at: endsAt,
        severity: classifyVmzSeverity(normalizedDescription),
        provenance: {
          ...provenance,
          contentHash,
        },
      },
    ];
  });
}

function splitVmzLines(text: string): string[] {
  return normalizePdfText(text)
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0);
}

function parseKnownFieldLine(
  line: string,
): { label: string; value: string } | undefined {
  const parsed = parseGenericFieldLine(line);

  if (parsed === undefined || !VMZ_FIELD_LABELS.has(parsed.label)) {
    return undefined;
  }

  return parsed;
}

function parseGenericFieldLine(
  line: string,
): { label: string; value: string } | undefined {
  const match =
    /^(?<label>[\p{Letter}][\p{Letter} /-]{0,40}):\s*(?<value>.*)$/u.exec(line);

  if (match?.groups === undefined) {
    return undefined;
  }

  const label = normalizeWhitespace(match.groups.label ?? '');
  const value = normalizeWhitespace(match.groups.value ?? '');

  if (label === '') {
    return undefined;
  }

  return { label, value };
}

function appendSegment(existing: string | undefined, next: string): string {
  const normalized = normalizeWhitespace(next);

  if (normalized === '') {
    return existing ?? '';
  }

  return existing === undefined || existing === ''
    ? normalized
    : normalizeWhitespace(`${existing} ${normalized}`);
}

function parseVmzDateRange(
  value: string,
): { startsAt: string; endsAt: string } | undefined {
  const match =
    /(?<start>\d{2}\.\d{2}\.\d{4})\s*-\s*(?<end>\d{2}\.\d{2}\.\d{4})/u.exec(
      value,
    );

  if (match?.groups === undefined) {
    return undefined;
  }

  const start = match.groups.start;
  const end = match.groups.end;

  if (start === undefined || end === undefined) {
    return undefined;
  }

  return {
    startsAt: berlinDateToIso(start, false),
    endsAt: berlinDateToIso(end, true),
  };
}

function parseVmzDateToIso(
  value: string,
  boundary: 'start' | 'end',
): string | undefined {
  const normalized = normalizeWhitespace(value)
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '');

  if (/^\d{2}\.\d{2}\.\d{4}$/u.test(normalized)) {
    return berlinDateToIso(normalized, boundary === 'end');
  }

  const germanMonthDate =
    /^(?<day>\d{1,2})\.\s*(?<month>[A-Za-z]+)\s+(?<year>\d{4})$/u.exec(
      normalized,
    );

  if (germanMonthDate?.groups !== undefined) {
    const dayText = germanMonthDate.groups.day;
    const monthText = germanMonthDate.groups.month;
    const yearText = germanMonthDate.groups.year;

    if (
      dayText === undefined ||
      monthText === undefined ||
      yearText === undefined
    ) {
      return undefined;
    }

    const day = Number(dayText);
    const month = GERMAN_MONTHS.get(monthText.toLowerCase());
    const year = Number(yearText);

    if (month !== undefined) {
      return buildBerlinIso(year, month, day, boundary === 'end');
    }
  }

  const quarterDate = /^Q(?<quarter>[1-4])\/(?<year>\d{4})$/iu.exec(normalized);

  if (quarterDate?.groups !== undefined) {
    const quarter = Number(quarterDate.groups.quarter);
    const year = Number(quarterDate.groups.year);
    const startMonth = (quarter - 1) * 3 + 1;
    const endMonth = quarter * 3;
    const day = boundary === 'end' ? daysInMonth(year, endMonth) : 1;

    return buildBerlinIso(
      year,
      boundary === 'end' ? endMonth : startMonth,
      day,
      boundary === 'end',
    );
  }

  return undefined;
}

function buildBerlinIso(
  year: number,
  month: number,
  day: number,
  endOfDay: boolean,
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

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function resolveVmzFeatureUrl(
  value: string | undefined,
  provenance: Provenance,
): string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }

  const urlMatch = /https?:\/\/\S+|[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/\S+/iu.exec(
    value,
  );

  if (urlMatch === null) {
    return undefined;
  }

  const rawCandidate = urlMatch[0].replace(/[),.;]+$/u, '');

  if (rawCandidate === '') {
    return undefined;
  }

  const candidate = /^[a-z]+:\/\//iu.test(rawCandidate)
    ? rawCandidate
    : `https://${rawCandidate}`;

  try {
    return new URL(candidate, provenance.sourceUrl).toString();
  } catch {
    return undefined;
  }
}

function classifyVmzKind(text: string): VmzRoadworkRecord['kind'] {
  return /umleitung/iu.test(text) &&
    !/baustelle|bauarbeit|bauarbeiten|vollsperrung|sperrung/iu.test(text)
    ? 'detour'
    : 'roadwork';
}

function classifyVmzSeverity(text: string): ExternalImpact['severity'] {
  if (/vollsperrung|voll gesperrt|gesperrt/iu.test(text)) {
    return 'high';
  }

  if (
    /umleitung|spurverengung|verkehrseinschränkung|verkehrseinschraenkung|verkehrseinschrankung/iu.test(
      text,
    )
  ) {
    return 'moderate';
  }

  return 'low';
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values.filter(
        (value): value is string =>
          value !== undefined && normalizeWhitespace(value) !== '',
      ),
    ),
  ];
}

function looksLikePdfAnchorText(value: string): boolean {
  return /\.pdf(?:\s*(?:\(|$))/iu.test(value);
}

async function defaultExtractPdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs =
    (await import('pdfjs-dist/legacy/build/pdf.mjs')) as PdfJsModule;
  const loadingTask = pdfjs.getDocument({
    data: Uint8Array.from(bytes),
  });
  const document = await loadingTask.promise;
  const pageCount = Math.min(document.numPages, MAX_PDF_PAGES);
  const chunks: string[] = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageLines: string[] = [];
    let previousY: number | undefined;
    let currentLine = '';

    for (const item of textContent.items) {
      const value = item.str ?? '';
      const y = Array.isArray(item.transform) ? item.transform[5] : undefined;

      if (
        y !== undefined &&
        previousY !== undefined &&
        Math.abs(y - previousY) > 0.5
      ) {
        const normalizedLine = normalizeWhitespace(currentLine);

        if (normalizedLine.length > 0) {
          pageLines.push(normalizedLine);
        }

        currentLine = '';
      }

      currentLine += value;

      if (y !== undefined) {
        previousY = y;
      }
    }

    const normalizedLine = normalizeWhitespace(currentLine);

    if (normalizedLine.length > 0) {
      pageLines.push(normalizedLine);
    }

    chunks.push(pageLines.join('\n'));
  }

  return chunks.filter((value) => value.length > 0).join('\n');
}

function toExternalImpact(record: VmzRoadworkRecord): ExternalImpact {
  return {
    id: record.id,
    title: record.title,
    summary: record.summary,
    details: record.location_terms.join(', '),
    corridor_ids: [],
    ...(record.starts_at === undefined ? {} : { starts_at: record.starts_at }),
    ...(record.ends_at === undefined ? {} : { ends_at: record.ends_at }),
    category: 'roadworks',
    severity: record.severity,
    provenance: record.provenance,
  };
}

function deduplicateImpacts(impacts: ExternalImpact[]): ExternalImpact[] {
  const deduplicated = new Map<string, ExternalImpact>();

  for (const impact of impacts) {
    const key = [
      impact.title,
      impact.summary,
      impact.starts_at ?? '',
      impact.ends_at ?? '',
      impact.provenance.source,
    ].join('|');

    deduplicated.set(key, impact);
  }

  return [...deduplicated.values()];
}

function stableId(
  source: Provenance['source'],
  sourceUrl: string,
  title: string,
  contentHash: string,
): string {
  return sha256Text([source, sourceUrl, title, contentHash].join('|')).slice(
    0,
    24,
  );
}

function isRssItem(value: unknown): value is RssItem {
  return value !== null && typeof value === 'object';
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/gu, ' ');
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function toIsoOrUndefined(value: string): string | undefined {
  if (value === '') {
    return undefined;
  }

  const parsed = Date.parse(value);

  if (Number.isNaN(parsed)) {
    return undefined;
  }

  return new Date(parsed).toISOString();
}

function berlinDateToIso(value: string, endOfDay: boolean): string {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/u.exec(value);

  if (match === null) {
    throw new Error(`Invalid VMZ date ${value}`);
  }

  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);

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

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
