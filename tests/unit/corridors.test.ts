import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadCorridors,
  matchCorridor,
  type MatchableRecord,
} from '../../src/config/corridors.js';

const tempDirs: string[] = [];

function writeCorridorsFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'corridors-test-'));
  tempDirs.push(dir);
  const path = join(dir, 'corridors.json');

  writeFileSync(path, JSON.stringify(contents, null, 2), 'utf8');

  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadCorridors', () => {
  it('rejects duplicate normalized aliases across corridors', () => {
    const path = writeCorridorsFile([
      { id: 'one', aliases: ['Hauptbahnhof'], line_ids: [] },
      { id: 'two', aliases: ['hauptbahnhof'], line_ids: [] },
    ]);

    expect(() => loadCorridors(path)).toThrow(/alias/i);
  });

  it('rejects blank corridor ids and line ids', () => {
    const blankIdPath = writeCorridorsFile([
      { id: '   ', aliases: ['Weserpark'], line_ids: ['25'] },
    ]);
    const blankLineIdPath = writeCorridorsFile([
      { id: 'east', aliases: ['Weserpark'], line_ids: ['   '] },
    ]);

    expect(() => loadCorridors(blankIdPath)).toThrow();
    expect(() => loadCorridors(blankLineIdPath)).toThrow();
  });

  it('rejects ids and aliases that normalize to empty text', () => {
    const punctuationIdPath = writeCorridorsFile([
      { id: '---', aliases: ['Weserpark'], line_ids: ['25'] },
    ]);
    const punctuationAliasPath = writeCorridorsFile([
      { id: 'east', aliases: ['---'], line_ids: ['25'] },
    ]);

    expect(() => loadCorridors(punctuationIdPath)).toThrow();
    expect(() => loadCorridors(punctuationAliasPath)).toThrow();
  });

  it('rejects line ids that normalize to empty text', () => {
    const punctuationLineIdPath = writeCorridorsFile([
      { id: 'east', aliases: ['Weserpark'], line_ids: ['---'] },
    ]);

    expect(() => loadCorridors(punctuationLineIdPath)).toThrow();
  });
});

describe('matchCorridor', () => {
  const corridor = {
    id: 'east',
    aliases: [
      'Ostertor',
      'Sankt-Jürgen-Straße',
      'Münchener Straße',
      'Weserpark',
    ],
    line_ids: ['1E', '25'],
  };

  it('prefers exact public line matches', () => {
    expect(
      matchCorridor(corridor, {
        lineId: '25',
        title: 'Unrelated notice',
      }),
    ).toEqual({
      corridor_id: 'east',
      confidence: 'exact',
      matched_aliases: ['25'],
    });
  });

  it('matches normalized unicode and punctuation aliases on phrase boundaries', () => {
    const record: MatchableRecord = {
      title: 'Sankt Jurgen Strasse stop closed near Weserpark',
      text: 'Shuttle service from Munchener Strasse',
    };

    expect(matchCorridor(corridor, record)).toEqual({
      corridor_id: 'east',
      confidence: 'phrase',
      matched_aliases: ['Sankt-Jürgen-Straße', 'Münchener Straße', 'Weserpark'],
    });
  });

  it('matches uppercase ẞ after unicode normalization', () => {
    const record: MatchableRecord = {
      title: 'SANKT-JURGEN-STRAẞE stop closed',
      text: 'Diversion via MUNCHENER STRAẞE',
    };

    expect(matchCorridor(corridor, record)).toEqual({
      corridor_id: 'east',
      confidence: 'phrase',
      matched_aliases: ['Sankt-Jürgen-Straße', 'Münchener Straße'],
    });
  });

  it('matches the new east VMZ street aliases on phrase boundaries only', () => {
    const eastCorridor = {
      id: 'east',
      aliases: [
        'Steubenstraße',
        'Vahrer Straße',
        'Kurfürstenallee',
        'Hastedter Heerstraße',
      ],
      line_ids: [],
    };
    const record: MatchableRecord = {
      title: 'Vollsperrung in der Steubenstraße ab April 2026',
      text: 'Tempo 30 gilt an der Kurfurstenallee und Vahrer Strasse; die Hastedter Heerstrasse bleibt erreichbar.',
    };

    expect(matchCorridor(eastCorridor, record)).toEqual({
      corridor_id: 'east',
      confidence: 'phrase',
      matched_aliases: [
        'Steubenstraße',
        'Vahrer Straße',
        'Kurfürstenallee',
        'Hastedter Heerstraße',
      ],
    });
  });

  it('matches the new west VMZ aliases without broadening to partial words', () => {
    const westCorridor = {
      id: 'west',
      aliases: ['Waller Straße', 'Waller See', 'Rübekamp'],
      line_ids: [],
    };
    const record: MatchableRecord = {
      title: 'Alte Waller Straße Baustelle',
      text: 'Arbeiten zwischen Waller See und Rubekamp.',
    };

    expect(matchCorridor(westCorridor, record)).toEqual({
      corridor_id: 'west',
      confidence: 'phrase',
      matched_aliases: ['Waller Straße', 'Waller See', 'Rübekamp'],
    });
  });

  it('does not match unrelated substrings inside words', () => {
    const record: MatchableRecord = {
      title: 'Kosten steigen im Zentrum',
      text: 'Keine Sperrung im Bereich',
    };

    expect(
      matchCorridor(
        {
          id: 'central',
          aliases: ['Ost'],
          line_ids: [],
        },
        record,
      ),
    ).toBeUndefined();
  });
});
