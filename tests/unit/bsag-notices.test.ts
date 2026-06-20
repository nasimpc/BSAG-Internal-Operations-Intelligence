import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  BSAG_OPERATIONAL_TERMS,
  parseBsagNoticesHtml,
} from '../../src/sources/bsag-notices.js';

const fixture = readFileSync(
  new URL('../fixtures/bsag-news.html', import.meta.url),
  'utf8',
);
const sourceUrl = new URL('https://www.bsag.de/unternehmen/aktuelles');
const fetchedAt = '2026-06-20T05:00:00Z';

describe('parseBsagNoticesHtml', () => {
  it('filters to operational records and extracts absolute URLs, lines, and stops', () => {
    const first = parseBsagNoticesHtml(fixture, sourceUrl, fetchedAt);
    const second = parseBsagNoticesHtml(fixture, sourceUrl, fetchedAt);

    expect(BSAG_OPERATIONAL_TERMS.length).toBeGreaterThan(0);
    expect(first.data).toHaveLength(2);
    expect(first.data.map((notice) => notice.id)).toEqual(
      second.data.map((notice) => notice.id),
    );
    const lineFourNotice = first.data.find((notice) =>
      notice.title.includes('Linie 4'),
    );
    const lineSixNotice = first.data.find((notice) =>
      notice.title.includes('Linie 6'),
    );

    expect(lineFourNotice).toBeDefined();
    expect(lineFourNotice?.lines).toEqual(['4']);
    expect(lineFourNotice?.stop_names).toEqual(['Domsheide']);
    expect(lineFourNotice?.provenance.source).toBe('bsag');
    expect(lineFourNotice?.provenance.sourceUrl).toBe(
      'https://www.bsag.de/aktuelles/linie-4-haltestelle-gesperrt',
    );

    expect(lineSixNotice).toBeDefined();
    expect(lineSixNotice?.lines).toEqual(['6', '6E']);
    expect(lineSixNotice?.stop_names).toEqual(['Flughafen Bremen']);
    expect(
      first.data.some((notice) => /Jahresbericht/i.test(notice.title)),
    ).toBe(false);
  });

  it('returns PARSER_NO_RECORDS for a structurally valid page without operational notice candidates', () => {
    const outcome = parseBsagNoticesHtml(
      '<main><article><h2>BSAG veröffentlicht Jahresbericht</h2><p>Unternehmensnachrichten.</p></article></main>',
      sourceUrl,
      fetchedAt,
    );

    expect(outcome.data).toEqual([]);
    expect(outcome.warnings).toContainEqual(
      expect.objectContaining({
        source: 'bsag',
        code: 'PARSER_NO_RECORDS',
      }),
    );
  });
});
