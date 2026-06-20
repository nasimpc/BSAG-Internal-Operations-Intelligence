import { describe, expect, it } from 'vitest';

import { loadEnv } from '../../src/config/env.js';

describe('loadEnv', () => {
  it('provides approved defaults', () => {
    const env = loadEnv({});

    expect(env).toMatchObject({
      timezone: 'Europe/Berlin',
      http: {
        host: '127.0.0.1',
      },
      retention: {
        days: 30,
      },
      realtime: {
        refreshIntervalSeconds: 60,
      },
      sources: {
        vbnRealtimeJsonUrl: 'http://gtfsr.vbn.de/gtfsr_connect.json',
        vbnRealtimeProtobufUrl: 'http://gtfsr.vbn.de/gtfsr_connect.bin',
        vbnNoticesUrl:
          'https://www.vbn.de/vbn/verkehrshinweise/bus-und-strassenbahnverkehr',
        bsagNewsUrl: 'https://www.bsag.de/unternehmen/aktuelles',
        vmzCurrentUrl: 'https://vmz.bremen.de/baustellen/aktuell',
        vmzPreviewUrl: 'https://vmz.bremen.de/baustellen/vorschau',
        vmzOverviewUrl:
          'https://vmz.bremen.de/baustellen/baustellenuebersicht',
        vmzRssUrl: 'https://vmz.bremen.de/verkehrslage/aktuell/feed.rss',
        bremenEventsUrl: 'https://www.bremen.de/kultur/veranstaltungen',
      },
    });
  });

  it('fails startup validation for malformed integer settings', () => {
    expect(() =>
      loadEnv({
        RETENTION_DAYS: 'thirty',
      }),
    ).toThrow(/RETENTION_DAYS/i);
  });
});
