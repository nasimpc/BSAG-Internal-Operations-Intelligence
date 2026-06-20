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
    const description = normalizeWhitespace(stripHtml(asString(item?.description)));
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
    const details = normalizeWhitespace([description, content].filter(Boolean).join(' '));
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

    if (href === undefined || !/\.pdf(?:$|\?)/iu.test(href)) {
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
  return normalizePdfText(text)
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0)
    .flatMap((line) => {
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
      const kind = /umleitung/iu.test(normalizedDescription)
        ? 'detour'
        : 'roadwork';
      const severity = /vollsperrung|gesperrt/iu.test(normalizedDescription)
        ? 'high'
        : /umleitung|spurverengung/iu.test(normalizedDescription)
          ? 'moderate'
          : 'low';
      const title = `${normalizedLocation} — ${normalizedDescription}`;
      const summary = `${normalizedDescription} from ${start} to ${end}`;
      const contentHash = sha256Text([title, startsAt, endsAt].join('|'));

      return [
        {
          id: stableId('vmz_pdf', provenance.sourceUrl, title, contentHash),
          kind,
          title,
          summary,
          location_terms: [normalizedLocation],
          starts_at: startsAt,
          ends_at: endsAt,
          severity,
          provenance: {
            ...provenance,
            contentHash,
          },
        },
      ];
    });
}

async function defaultExtractPdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as PdfJsModule;
  const loadingTask = pdfjs.getDocument({ data: bytes });
  const document = await loadingTask.promise;
  const pageCount = Math.min(document.numPages, MAX_PDF_PAGES);
  const chunks: string[] = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const textContent = await page.getTextContent();

    chunks.push(
      normalizeWhitespace(
        textContent.items
          .map((item) => normalizeWhitespace(item.str ?? ''))
          .filter((value) => value.length > 0)
          .join(' '),
      ),
    );
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
