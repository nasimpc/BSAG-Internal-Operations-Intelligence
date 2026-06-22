import { z } from 'zod';

const urlSchema = z.url();

const envSchema = z.object({
  TZ: z.literal('Europe/Berlin').default('Europe/Berlin'),
  HTTP_HOST: z.string().default('127.0.0.1'),
  RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  REALTIME_REFRESH_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(5)
    .max(3600)
    .default(300),
  VBN_REALTIME_JSON_URL: urlSchema.default(
    'http://gtfsr.vbn.de/gtfsr_connect.json',
  ),
  VBN_REALTIME_PROTOBUF_URL: urlSchema.default(
    'http://gtfsr.vbn.de/gtfsr_connect.bin',
  ),
  VBN_NOTICES_URL: urlSchema.default(
    'https://www.vbn.de/vbn/verkehrshinweise/bus-und-strassenbahnverkehr',
  ),
  BSAG_NEWS_URL: urlSchema.default('https://www.bsag.de/unternehmen/aktuelles'),
  VMZ_CURRENT_URL: urlSchema.default(
    'https://vmz.bremen.de/baustellen/aktuell',
  ),
  VMZ_PREVIEW_URL: urlSchema.default(
    'https://vmz.bremen.de/baustellen/vorschau',
  ),
  VMZ_OVERVIEW_URL: urlSchema.default(
    'https://vmz.bremen.de/baustellen/baustellenuebersicht',
  ),
  VMZ_RSS_URL: urlSchema.default(
    'https://vmz.bremen.de/verkehrslage/aktuell/feed.rss',
  ),
  BREMEN_EVENTS_URL: urlSchema.default(
    'https://www.bremen.de/kultur/veranstaltungen',
  ),
});

export interface EnvConfig {
  timezone: 'Europe/Berlin';
  http: {
    host: string;
  };
  retention: {
    days: number;
  };
  realtime: {
    refreshIntervalSeconds: number;
  };
  sources: {
    vbnRealtimeJsonUrl: string;
    vbnRealtimeProtobufUrl: string;
    vbnNoticesUrl: string;
    bsagNewsUrl: string;
    vmzCurrentUrl: string;
    vmzPreviewUrl: string;
    vmzOverviewUrl: string;
    vmzRssUrl: string;
    bremenEventsUrl: string;
  };
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

export function loadEnv(
  input: Record<string, string | undefined>,
): Readonly<EnvConfig> {
  const parsed = envSchema.parse(input);

  return deepFreeze({
    timezone: parsed.TZ,
    http: {
      host: parsed.HTTP_HOST,
    },
    retention: {
      days: parsed.RETENTION_DAYS,
    },
    realtime: {
      refreshIntervalSeconds: parsed.REALTIME_REFRESH_INTERVAL_SECONDS,
    },
    sources: {
      vbnRealtimeJsonUrl: parsed.VBN_REALTIME_JSON_URL,
      vbnRealtimeProtobufUrl: parsed.VBN_REALTIME_PROTOBUF_URL,
      vbnNoticesUrl: parsed.VBN_NOTICES_URL,
      bsagNewsUrl: parsed.BSAG_NEWS_URL,
      vmzCurrentUrl: parsed.VMZ_CURRENT_URL,
      vmzPreviewUrl: parsed.VMZ_PREVIEW_URL,
      vmzOverviewUrl: parsed.VMZ_OVERVIEW_URL,
      vmzRssUrl: parsed.VMZ_RSS_URL,
      bremenEventsUrl: parsed.BREMEN_EVENTS_URL,
    },
  });
}
