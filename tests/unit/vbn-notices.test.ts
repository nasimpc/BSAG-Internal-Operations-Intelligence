import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseVbnNoticesHtml } from '../../src/sources/vbn-notices.js';

const fixture = readFileSync(
  new URL('../fixtures/vbn-notices.html', import.meta.url),
  'utf8',
);
const sourceUrl = new URL(
  'https://www.vbn.de/vbn/verkehrshinweise/bus-und-strassenbahnverkehr',
);
const fetchedAt = '2026-06-20T05:00:00Z';

describe('parseVbnNoticesHtml', () => {
  it('extracts stable IDs, effective dates, exact line tokens, and affected stops', () => {
    const first = parseVbnNoticesHtml(fixture, sourceUrl, fetchedAt);
    const second = parseVbnNoticesHtml(fixture, sourceUrl, fetchedAt);

    expect(first.data).toHaveLength(2);
    expect(first.data.map((notice) => notice.id)).toEqual(
      second.data.map((notice) => notice.id),
    );
    const lineOneNotice = first.data.find((notice) =>
      notice.title.includes('Linie 1'),
    );

    expect(lineOneNotice).toBeDefined();
    expect(lineOneNotice?.lines).toEqual(['1', 'N1']);
    expect(lineOneNotice?.stop_names).toEqual(['Hauptbahnhof', 'Am Dobben']);
    expect(lineOneNotice?.valid_from).toBe('2026-06-20T03:00:00.000Z');
    expect(lineOneNotice?.valid_to).toBe('2026-06-21T16:00:00.000Z');
    expect(lineOneNotice?.provenance.source).toBe('vbn_notices');
    expect(lineOneNotice?.provenance.sourceUrl).toBe(
      'https://www.vbn.de/vbn/verkehrshinweise/detail/linie-1-umleitung',
    );

    const lineTenNotice = first.data.find((notice) =>
      notice.title.includes('Linie 10'),
    );

    expect(lineTenNotice?.valid_from).toBe('2026-06-21T22:00:00.000Z');
    expect(first.warnings).toEqual([]);
  });

  it('parses date-only validity windows, falls back to the listing URL, and skips non-line notices', () => {
    const outcome = parseVbnNoticesHtml(
      [
        '<main>',
        '  <article>',
        '    <h2>Linie 8 Umleitung</h2>',
        '    <p>Dauer: 21.06.2026 bis 22.06.2026</p>',
        '    <p>Linie: 8</p>',
        '    <p>Betroffene: Sebaldsbrück</p>',
        '  </article>',
        '  <article>',
        '    <h2>Allgemeine Information</h2>',
        '    <p>Dauer: 21.06.2026 bis 22.06.2026</p>',
        '  </article>',
        '</main>',
      ].join('\n'),
      sourceUrl,
      fetchedAt,
    );

    expect(outcome.data).toHaveLength(1);
    expect(outcome.data[0]).toMatchObject({
      title: 'Linie 8 Umleitung',
      summary: 'Linie 8 Umleitung',
      lines: ['8'],
      stop_names: ['Sebaldsbrück'],
      valid_from: '2026-06-20T22:00:00.000Z',
      valid_to: '2026-06-22T21:59:59.999Z',
    });
    expect(outcome.data[0]?.provenance.sourceUrl).toBe(sourceUrl.toString());
    expect(outcome.warnings).toEqual([]);
  });

  it('parses current accordion notices with page anchors and German date ranges', () => {
    const outcome = parseVbnNoticesHtml(
      [
        '<main>',
        '  <div class="accordion" id="accordion-19727">',
        '    <div class="co-accordion card">',
        '      <div class="card-header">',
        '        <h5><button>BSAG Linie 2: Gleisbauarbeiten in der Zeit vom 8. bis 29. Juni 2026</button></h5>',
        '      </div>',
        '      <div class="card-body">',
        '        <p>Aufgrund von Gleisbauarbeiten wird die Linie 2 umgeleitet.</p>',
        '        <p><strong>Haltestellenänderungen:</strong></p>',
        '        <ul>',
        '          <li>Haferkamp (Steig C) &gt; verlegt zu Steig A</li>',
        '          <li>Lloydstraße &gt; entfällt</li>',
        '          <li>Doventorsteinweg (Linie 10) &gt; wird zusätzlich bedient</li>',
        '        </ul>',
        '      </div>',
        '    </div>',
        '  </div>',
        '</main>',
      ].join('\n'),
      sourceUrl,
      fetchedAt,
    );

    expect(outcome.data).toHaveLength(1);
    expect(outcome.data[0]).toMatchObject({
      title:
        'BSAG Linie 2: Gleisbauarbeiten in der Zeit vom 8. bis 29. Juni 2026',
      summary: 'Aufgrund von Gleisbauarbeiten wird die Linie 2 umgeleitet.',
      lines: ['2'],
      stop_names: ['Haferkamp (Steig C)', 'Lloydstraße', 'Doventorsteinweg'],
      valid_from: '2026-06-07T22:00:00.000Z',
      valid_to: '2026-06-29T21:59:59.999Z',
      severity: 'critical',
    });
    expect(outcome.data[0]?.provenance.sourceUrl).toBe(
      `${sourceUrl.toString()}#accordion-19727`,
    );
    expect(outcome.warnings).toEqual([]);
  });

  it('returns an empty complete outcome for a page without candidate notices', () => {
    const outcome = parseVbnNoticesHtml(
      '<main><article><h2>Allgemeine Hinweise</h2><p>Keine Änderungen.</p></article></main>',
      sourceUrl,
      fetchedAt,
    );

    expect(outcome.data).toEqual([]);
    expect(outcome.warnings).toEqual([]);
  });

  it('warns when an operational-looking page has no parseable notice containers', () => {
    const outcome = parseVbnNoticesHtml(
      '<main><div>Linie 4: Umleitung wegen Baustelle an der Domsheide</div></main>',
      sourceUrl,
      fetchedAt,
    );

    expect(outcome.data).toEqual([]);
    expect(outcome.warnings).toContainEqual(
      expect.objectContaining({
        source: 'vbn_notices',
        code: 'PARSER_NO_RECORDS',
      }),
    );
  });
});
