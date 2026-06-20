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
    const lineOneNotice = first.data.find((notice) => notice.title.includes('Linie 1'));

    expect(lineOneNotice).toBeDefined();
    expect(lineOneNotice?.lines).toEqual(['1', 'N1']);
    expect(lineOneNotice?.stop_names).toEqual(['Hauptbahnhof', 'Am Dobben']);
    expect(lineOneNotice?.valid_from).toBe('2026-06-20T03:00:00.000Z');
    expect(lineOneNotice?.valid_to).toBe('2026-06-21T16:00:00.000Z');
    expect(lineOneNotice?.provenance.source).toBe('vbn_notices');
    expect(lineOneNotice?.provenance.sourceUrl).toBe(
      'https://www.vbn.de/vbn/verkehrshinweise/detail/linie-1-umleitung',
    );
    expect(first.warnings).toContainEqual(
      expect.objectContaining({
        source: 'vbn_notices',
        code: 'MISSING_EFFECTIVE_DATE',
      }),
    );
  });

  it('returns PARSER_NO_RECORDS for a structurally valid page without candidate notices', () => {
    const outcome = parseVbnNoticesHtml(
      '<main><article><h2>Allgemeine Hinweise</h2><p>Keine Änderungen.</p></article></main>',
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
