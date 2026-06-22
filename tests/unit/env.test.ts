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
        refreshIntervalSeconds: 300,
      },
      sources: {
        vbnRealtimeJsonUrl: 'http://gtfsr.vbn.de/gtfsr_connect.json',
        vbnRealtimeProtobufUrl: 'http://gtfsr.vbn.de/gtfsr_connect.bin',
        vbnNoticesUrl:
          'https://www.vbn.de/vbn/verkehrshinweise/bus-und-strassenbahnverkehr',
        bsagNewsUrl: 'https://www.bsag.de/unternehmen/aktuelles',
        vmzCurrentUrl: 'https://vmz.bremen.de/baustellen/aktuell',
        vmzPreviewUrl: 'https://vmz.bremen.de/baustellen/vorschau',
        vmzOverviewUrl: 'https://vmz.bremen.de/baustellen/baustellenuebersicht',
        vmzRssUrl: 'https://vmz.bremen.de/verkehrslage/aktuell/feed.rss',
        bremenEventsUrl: 'https://www.bremen.de/kultur/veranstaltungen',
      },
    });
  });

  it('coerces bounded integer settings', () => {
    const env = loadEnv({
      RETENTION_DAYS: '45',
      REALTIME_REFRESH_INTERVAL_SECONDS: '120',
    });

    expect(env.retention.days).toBe(45);
    expect(env.realtime.refreshIntervalSeconds).toBe(120);
  });

  it('fails startup validation for malformed integer settings', () => {
    expect(() =>
      loadEnv({
        RETENTION_DAYS: 'thirty',
      }),
    ).toThrow(/RETENTION_DAYS/i);
  });

  it('rejects out-of-range integer settings', () => {
    expect(() =>
      loadEnv({
        RETENTION_DAYS: '0',
      }),
    ).toThrow(/RETENTION_DAYS/i);

    expect(() =>
      loadEnv({
        REALTIME_REFRESH_INTERVAL_SECONDS: '3601',
      }),
    ).toThrow(/REALTIME_REFRESH_INTERVAL_SECONDS/i);
  });

  it('returns an immutable configuration tree', () => {
    const env = loadEnv({});

    expect(Object.isFrozen(env)).toBe(true);
    expect(Object.isFrozen(env.http)).toBe(true);
    expect(Object.isFrozen(env.retention)).toBe(true);
    expect(Object.isFrozen(env.realtime)).toBe(true);
    expect(Object.isFrozen(env.sources)).toBe(true);
  });
});
