import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type {
  BinaryFetchPolicy,
  FetchResponse,
  TextFetchPolicy,
} from '../../src/sources/http-client.js';
import {
  discoverVmzPdfUrls,
  parseVmzFeedXml,
  parseVmzRoadworksText,
  VmzSource,
} from '../../src/sources/vmz.js';

const feedFixture = readFileSync(
  new URL('../fixtures/vmz-feed.xml', import.meta.url),
  'utf8',
);
const roadworksHtmlFixture = readFileSync(
  new URL('../fixtures/vmz-roadworks.html', import.meta.url),
  'utf8',
);
const roadworksTextFixture = readFileSync(
  new URL('../fixtures/vmz-roadworks.txt', import.meta.url),
  'utf8',
);

const rssUrl = new URL('https://vmz.bremen.de/verkehrslage/aktuell/feed.rss');
const currentUrl = new URL('https://vmz.bremen.de/baustellen/aktuell');
const previewUrl = new URL('https://vmz.bremen.de/baustellen/vorschau');
const overviewUrl = new URL(
  'https://vmz.bremen.de/baustellen/baustellenuebersicht',
);
const fetchedAt = '2026-06-20T05:00:00Z';

interface StubClock {
  now(): Date;
}

class FixedClock implements StubClock {
  constructor(private readonly value: string) {}

  now(): Date {
    return new Date(this.value);
  }
}

class StubVmzClient {
  readonly #textResponses: Map<string, string>;
  readonly #byteResponses: Map<string, Uint8Array>;

  constructor(options: {
    textResponses?: Record<string, string>;
    byteResponses?: Record<string, Uint8Array>;
  }) {
    this.#textResponses = new Map(Object.entries(options.textResponses ?? {}));
    this.#byteResponses = new Map(Object.entries(options.byteResponses ?? {}));
  }

  getText(url: URL, policy: TextFetchPolicy): Promise<FetchResponse<string>> {
    void policy;
    const body = this.#textResponses.get(url.toString());

    if (body === undefined) {
      throw new Error(`Unexpected text URL ${url.toString()}`);
    }

    return Promise.resolve({
      body,
      finalUrl: new URL(url),
      contentType: 'text/plain',
      statusCode: 200,
      attempts: 1,
      redirectCount: 0,
    });
  }

  getBytes(
    url: URL,
    policy: BinaryFetchPolicy,
  ): Promise<FetchResponse<Uint8Array>> {
    void policy;
    const body = this.#byteResponses.get(url.toString());

    if (body === undefined) {
      throw new Error(`Unexpected byte URL ${url.toString()}`);
    }

    return Promise.resolve({
      body,
      finalUrl: new URL(url),
      contentType: 'application/pdf',
      statusCode: 200,
      attempts: 1,
      redirectCount: 0,
    });
  }
}

describe('parseVmzFeedXml', () => {
  it('parses namespaced RSS items and warns on malformed items', () => {
    const outcome = parseVmzFeedXml(feedFixture, rssUrl, fetchedAt);
    const accidentImpact = outcome.data.find((impact) =>
      impact.title.includes('A27: Unfall'),
    );
    const roadworkImpact = outcome.data.find((impact) =>
      impact.title.includes('B75: Baustelle'),
    );

    expect(outcome.data).toHaveLength(2);
    expect(accidentImpact).toBeDefined();
    expect(accidentImpact?.category).toBe('incident');
    expect(accidentImpact?.severity).toBe('moderate');
    expect(accidentImpact?.provenance.source).toBe('vmz_rss');
    expect(accidentImpact?.provenance.sourceUrl).toBe(
      'https://vmz.bremen.de/verkehrslage/aktuell/a27-unfall',
    );
    expect(roadworkImpact).toBeDefined();
    expect(roadworkImpact?.category).toBe('roadworks');
    expect(outcome.warnings).toContainEqual(
      expect.objectContaining({
        source: 'vmz_rss',
        code: 'PARSER_ITEM_INVALID',
      }),
    );
  });
});

describe('discoverVmzPdfUrls', () => {
  it('resolves relative URLs and deduplicates discovered PDF links', () => {
    const urls = discoverVmzPdfUrls(roadworksHtmlFixture, currentUrl);

    expect(urls.map((url) => url.toString())).toEqual([
      'https://vmz.bremen.de/media/verkehr/baustellenpresse/baustellenpresse_kw25.pdf',
      'https://vmz.bremen.de/media/verkehr/sondermeldung.pdf',
    ]);
  });
});

describe('parseVmzRoadworksText', () => {
  it('extracts German date ranges, locations, and detour terms from normalized PDF text', () => {
    const provenance = {
      source: 'vmz_pdf' as const,
      sourceUrl:
        'https://vmz.bremen.de/media/verkehr/baustellenpresse/baustellenpresse_kw25.pdf',
      fetchedAt,
    };
    const parsed = parseVmzRoadworksText(roadworksTextFixture, provenance);
    const roadwork = parsed.find((record) => record.kind === 'roadwork');
    const detour = parsed.find((record) => record.kind === 'detour');

    expect(roadwork).toBeDefined();
    expect(roadwork?.location_terms).toContain('Steubenstraße');
    expect(roadwork?.starts_at).toBe('2026-04-06T22:00:00.000Z');
    expect(roadwork?.ends_at).toBe('2028-12-31T22:59:59.999Z');
    expect(detour).toBeDefined();
    expect(detour?.location_terms).toContain('Utbremer Ring');
  });
});

describe('VmzSource', () => {
  it('fetches RSS and PDF bytes, normalizes extracted text, and keeps valid records when one PDF fails', async () => {
    const client = new StubVmzClient({
      textResponses: {
        [rssUrl.toString()]: feedFixture,
        [currentUrl.toString()]: roadworksHtmlFixture,
        [previewUrl.toString()]: roadworksHtmlFixture,
        [overviewUrl.toString()]: roadworksHtmlFixture,
      },
      byteResponses: {
        'https://vmz.bremen.de/media/verkehr/baustellenpresse/baustellenpresse_kw25.pdf':
          new TextEncoder().encode('kw25'),
        'https://vmz.bremen.de/media/verkehr/sondermeldung.pdf':
          new TextEncoder().encode('sondermeldung'),
      },
    });
    const extractedBytes: string[] = [];
    const source = new VmzSource({
      client,
      clock: new FixedClock(fetchedAt),
      currentUrl,
      overviewUrl,
      previewUrl,
      rssUrl,
      extractPdfText: (bytes) => {
        const marker = new TextDecoder().decode(bytes);
        extractedBytes.push(marker);

        if (marker === 'sondermeldung') {
          throw new Error('synthetic extractor failure');
        }

        return Promise.resolve(
          `Steubenstraße\n—   Vollsperrung vom 07.04.2026 bis 31.12.2028`,
        );
      },
    });

    const outcome = await source.fetch();
    const titles = outcome.data.map((impact) => impact.title);
    const roadworksImpact = outcome.data.find((impact) =>
      impact.title.includes('Steubenstraße'),
    );

    expect(extractedBytes.sort()).toEqual(['kw25', 'sondermeldung']);
    expect(titles).toEqual(
      expect.arrayContaining([
        'A27: Unfall zwischen Horn-Lehe und Vahr',
        'B75: Baustelle an der Stephanibrücke',
        'Steubenstraße — Vollsperrung',
      ]),
    );
    expect(roadworksImpact).toBeDefined();
    expect(roadworksImpact?.category).toBe('roadworks');
    expect(roadworksImpact?.corridor_ids).toEqual([]);
    expect(roadworksImpact?.severity).toBe('high');
    expect(roadworksImpact?.provenance.source).toBe('vmz_pdf');
    expect(outcome.warnings).toContainEqual(
      expect.objectContaining({
        source: 'vmz_pdf',
        code: 'PDF_EXTRACT_FAILED',
      }),
    );
    expect(outcome.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'vmz_rss', stale: false }),
        expect.objectContaining({ source: 'vmz_web', stale: false }),
        expect.objectContaining({ source: 'vmz_pdf', stale: false }),
      ]),
    );
  });
});
