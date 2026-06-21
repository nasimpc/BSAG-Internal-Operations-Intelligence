import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadLineRouteMap } from '../../src/config/line-route-map.js';

describe('loadLineRouteMap', () => {
  it('loads string and array route mappings with trimmed, deduplicated route IDs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bsag-line-route-map-'));
    const path = join(dir, 'line-route-map.json');

    try {
      writeFileSync(
        path,
        JSON.stringify({
          ' 6 ': [' 35757_0 ', '35757_0', '35757_1'],
          '10': '35755_0',
        }),
      );

      const routeMap = loadLineRouteMap(path);

      expect(routeMap.get('6')).toEqual(['35757_0', '35757_1']);
      expect(routeMap.get('10')).toEqual(['35755_0']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects empty route ID lists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bsag-line-route-map-'));
    const path = join(dir, 'line-route-map.json');

    try {
      writeFileSync(path, JSON.stringify({ '6': [] }));

      expect(() => loadLineRouteMap(path)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
