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
const weeklyRoadworksTextFixture = readFileSync(
  new URL('../fixtures/vmz-weekly-roadworks.txt', import.meta.url),
  'utf8',
);
const specialRoadworksTextFixture = readFileSync(
  new URL('../fixtures/vmz-special-steubenstrasse.txt', import.meta.url),
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
  it('accepts dumpFile anchors by PDF file name and keeps direct PDF links', () => {
    const urls = discoverVmzPdfUrls(roadworksHtmlFixture, currentUrl);

    expect(urls.map((url) => url.toString())).toEqual([
      'https://vmz.bremen.de/index.php?eID=dumpFile&f=126593&t=f&token=weekly-token',
      'https://vmz.bremen.de/media/verkehr/sondermeldung.pdf',
    ]);
  });
});

describe('parseVmzRoadworksText', () => {
  it('parses weekly bulletins into multiple VMZ records with per-record feature URLs', () => {
    const provenance = {
      source: 'vmz_pdf' as const,
      sourceUrl:
        'https://vmz.bremen.de/index.php?eID=dumpFile&f=126593&t=f&token=weekly-token',
      fetchedAt,
    };
    const parsed = parseVmzRoadworksText(
      weeklyRoadworksTextFixture,
      provenance,
    );
    const westRecord = parsed.find((record) =>
      record.title.includes('Alte Waller Straße'),
    );
    const eastRecord = parsed.find((record) =>
      record.title.includes('Hastedter Heerstraße'),
    );

    expect(parsed).toHaveLength(2);
    expect(westRecord).toMatchObject({
      kind: 'roadwork',
      starts_at: '2026-06-18T22:00:00.000Z',
      ends_at: '2026-06-19T21:59:59.999Z',
      provenance: {
        source: 'vmz_pdf',
        sourceUrl:
          'https://vmz.bremen.de/baustellen/alte-waller-strasse-waller-see',
      },
    });
    expect(westRecord?.summary).toContain(
      'Zeitraum: 19.06.2026 - 19.06.2026 tagsüber.',
    );
    expect(westRecord?.location_terms).toEqual(
      expect.arrayContaining([
        'Alte Waller Straße',
        'zwischen Waller See und Rübekamp',
        'stadteinwärts',
      ]),
    );
    expect(eastRecord).toMatchObject({
      kind: 'roadwork',
      starts_at: '2026-06-20T22:00:00.000Z',
      ends_at: '2026-06-23T21:59:59.999Z',
      provenance: {
        source: 'vmz_pdf',
        sourceUrl:
          'https://vmz.bremen.de/baustellen/hastedter-heerstrasse-vahrer-strasse',
      },
    });
    expect(eastRecord?.summary).toContain('Vahrer Straße / Steubenstraße');
  });

  it('parses the Steubenstraße special press release with Q4 end dates', () => {
    const provenance = {
      source: 'vmz_pdf' as const,
      sourceUrl: 'https://vmz.bremen.de/media/verkehr/sondermeldung.pdf',
      fetchedAt,
    };
    const parsed = parseVmzRoadworksText(
      specialRoadworksTextFixture,
      provenance,
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      kind: 'roadwork',
      title: 'Vollsperrung in der Steubenstraße ab April 2026',
      starts_at: '2026-04-06T22:00:00.000Z',
      ends_at: '2028-12-31T22:59:59.999Z',
      provenance: {
        source: 'vmz_pdf',
        sourceUrl: 'https://vmz.bremen.de/media/verkehr/sondermeldung.pdf',
      },
    });
    expect(parsed[0]?.summary).toContain('Kurfürstenallee');
    expect(parsed[0]?.summary).toContain('Vahrer Straße');
    expect(parsed[0]?.summary).toContain('Hastedter Heerstraße');
  });
});

describe('VmzSource', () => {
  it('fetches RSS and VMZ PDFs, keeps weekly records, and warns when one PDF extraction fails', async () => {
    const client = new StubVmzClient({
      textResponses: {
        [rssUrl.toString()]: feedFixture,
        [currentUrl.toString()]: roadworksHtmlFixture,
        [previewUrl.toString()]: roadworksHtmlFixture,
        [overviewUrl.toString()]: roadworksHtmlFixture,
      },
      byteResponses: {
        'https://vmz.bremen.de/index.php?eID=dumpFile&f=126593&t=f&token=weekly-token':
          new TextEncoder().encode('weekly'),
        'https://vmz.bremen.de/media/verkehr/sondermeldung.pdf':
          new TextEncoder().encode('special'),
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

        if (marker === 'special') {
          throw new Error('synthetic extractor failure');
        }

        return Promise.resolve(weeklyRoadworksTextFixture);
      },
    });

    const outcome = await source.fetch();
    const titles = outcome.data.map((impact) => impact.title);
    const westImpact = outcome.data.find((impact) =>
      impact.title.includes('Alte Waller Straße'),
    );
    const eastImpact = outcome.data.find((impact) =>
      impact.title.includes('Hastedter Heerstraße'),
    );

    expect(extractedBytes.sort()).toEqual(['special', 'weekly']);
    expect(titles).toEqual(
      expect.arrayContaining([
        'A27: Unfall zwischen Horn-Lehe und Vahr',
        'B75: Baustelle an der Stephanibrücke',
        'Alte Waller Straße — Fahrbahnsanierung mit halbseitiger Sperrung',
        'Hastedter Heerstraße — Baustelle mit Spurverengung',
      ]),
    );
    expect(westImpact).toBeDefined();
    expect(westImpact?.category).toBe('roadworks');
    expect(westImpact?.corridor_ids).toEqual([]);
    expect(westImpact?.severity).toBe('low');
    expect(westImpact?.provenance.source).toBe('vmz_pdf');
    expect(westImpact?.provenance.sourceUrl).toBe(
      'https://vmz.bremen.de/baustellen/alte-waller-strasse-waller-see',
    );
    expect(eastImpact?.provenance.sourceUrl).toBe(
      'https://vmz.bremen.de/baustellen/hastedter-heerstrasse-vahrer-strasse',
    );
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
