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

  it('returns an empty complete outcome for a page without operational notice candidates', () => {
    const outcome = parseBsagNoticesHtml(
      '<main><article><h2>BSAG veröffentlicht Jahresbericht</h2><p>Unternehmensnachrichten.</p></article></main>',
      sourceUrl,
      fetchedAt,
    );

    expect(outcome.data).toEqual([]);
    expect(outcome.warnings).toEqual([]);
  });

  it('parses current BSAG news cards with whitespace overlay links and global operational scope', () => {
    const outcome = parseBsagNoticesHtml(
      [
        '<main>',
        '  <div class="article articletype-0 card" itemscope itemtype="http://schema.org/Article">',
        '    <div class="body">',
        '      <span class="news-list-date"><time itemprop="datePublished" datetime="2026-05-18">18.05.2026</time></span>',
        '      <h2 itemprop="headline">Einschränkungen bei Fahrgastinfos und Echtzeitdaten</h2>',
        '      <div itemprop="description"><p>Wartungsarbeiten am Mittwoch</p></div>',
        '    </div>',
        '    <a title="Einschränkungen bei Fahrgastinfos und Echtzeitdaten" href="/unternehmen/aktuelles/meldung/einschraenkungen-bei-fahrgastinfos-und-echtzeitdaten">&nbsp;</a>',
        '  </div>',
        '</main>',
      ].join('\n'),
      sourceUrl,
      fetchedAt,
    );

    expect(outcome.data).toHaveLength(1);
    expect(outcome.data[0]).toMatchObject({
      title: 'Einschränkungen bei Fahrgastinfos und Echtzeitdaten',
      summary: 'Wartungsarbeiten am Mittwoch',
      lines: [],
      stop_names: [],
      severity: 'warning',
      provenance: {
        source: 'bsag',
        sourceUrl:
          'https://www.bsag.de/unternehmen/aktuelles/meldung/einschraenkungen-bei-fahrgastinfos-und-echtzeitdaten',
        publishedAt: '2026-05-17T22:00:00.000Z',
      },
    });
    expect(outcome.warnings).toEqual([]);
  });

  it('warns when an operational-looking page has no parseable notice containers', () => {
    const outcome = parseBsagNoticesHtml(
      '<main><div>Linie 4: Umleitung wegen Baustelle an der Domsheide</div></main>',
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
