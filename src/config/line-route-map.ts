import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { InputError } from '../shared/dates.js';

const lineIdSchema = z.string().trim().min(1);
const routeIdListSchema = z.union([lineIdSchema, z.array(lineIdSchema).min(1)]);
const lineRouteMapSchema = z.record(lineIdSchema, routeIdListSchema);

export type LineRouteMap = ReadonlyMap<string, readonly string[]>;

export function loadLineRouteMap(path: string): LineRouteMap {
  const parsed = lineRouteMapSchema.parse(
    JSON.parse(readFileSync(path, 'utf8')),
  );
  const routeMap = new Map<string, readonly string[]>();

  for (const [lineId, routeIds] of Object.entries(parsed)) {
    const normalizedLineId = lineId.trim();
    const normalizedRouteIds = dedupeRouteIds(
      Array.isArray(routeIds) ? routeIds : [routeIds],
    );

    if (routeMap.has(normalizedLineId)) {
      throw new InputError('Duplicate public line id ' + normalizedLineId);
    }

    routeMap.set(normalizedLineId, Object.freeze(normalizedRouteIds));
  }

  return routeMap;
}

function dedupeRouteIds(routeIds: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const routeId of routeIds) {
    const trimmed = routeId.trim();

    if (seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}
