import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { InputError } from '../shared/dates.js';

const corridorSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1).optional(),
  aliases: z.array(z.string().min(1)).min(1),
  line_ids: z.array(z.string().min(1)),
});

const corridorsSchema = z.array(corridorSchema);

export type Corridor = z.infer<typeof corridorSchema>;

export interface MatchableRecord {
  lineId?: string;
  title?: string;
  text?: string;
  location?: string;
}

export interface CorridorMatch {
  corridor_id: string;
  confidence: 'exact' | 'phrase';
  matched_aliases: string[];
}

function normalizePhrase(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/ß/g, 'ss')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/ß/g, 'ss')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '')
    .toLowerCase();
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    Object.freeze(value);

    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }

  return value;
}

export function loadCorridors(path: string): ReadonlyArray<Readonly<Corridor>> {
  const parsed = corridorsSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const ids = new Set<string>();
  const aliases = new Map<string, string>();

  for (const corridor of parsed) {
    if (ids.has(corridor.id)) {
      throw new InputError(`Duplicate corridor id "${corridor.id}"`);
    }
    ids.add(corridor.id);

    for (const alias of corridor.aliases) {
      const normalized = normalizePhrase(alias);
      const owner = aliases.get(normalized);

      if (owner) {
        throw new InputError(
          `Duplicate normalized alias "${alias}" for corridors "${owner}" and "${corridor.id}"`,
        );
      }

      aliases.set(normalized, corridor.id);
    }
  }

  return deepFreeze(parsed.map((corridor) => ({ ...corridor })));
}

export function matchCorridor(
  corridor: Corridor,
  record: MatchableRecord,
): CorridorMatch | undefined {
  const recordLineKey = record.lineId ? normalizeKey(record.lineId) : '';

  for (const lineId of corridor.line_ids) {
    if (recordLineKey !== '' && normalizeKey(lineId) === recordLineKey) {
      return {
        corridor_id: corridor.id,
        confidence: 'exact',
        matched_aliases: [lineId],
      };
    }
  }

  const haystack = normalizePhrase(
    [record.title, record.text, record.location].filter(Boolean).join(' '),
  );

  if (haystack === '') {
    return undefined;
  }

  const paddedHaystack = ` ${haystack} `;
  const matchedAliases = corridor.aliases.filter((alias) => {
    const normalizedAlias = normalizePhrase(alias);

    return normalizedAlias !== '' && paddedHaystack.includes(` ${normalizedAlias} `);
  });

  if (matchedAliases.length === 0) {
    return undefined;
  }

  return {
    corridor_id: corridor.id,
    confidence: 'phrase',
    matched_aliases: matchedAliases,
  };
}
