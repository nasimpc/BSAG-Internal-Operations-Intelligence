import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { Dispatcher } from 'undici';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { loadCorridors } from './config/corridors.js';
import { loadEnv, type EnvConfig } from './config/env.js';
import { logger as defaultLogger } from './shared/logger.js';
import { type Clock, SystemClock } from './shared/clock.js';
import { openDatabase } from './storage/database.js';
import { createRepositories } from './storage/repositories.js';
import {
  SourceHttpClient,
  type TextFetchPolicy,
} from './sources/http-client.js';
import { parseVbnNoticesHtml } from './sources/vbn-notices.js';
import { parseBsagNoticesHtml } from './sources/bsag-notices.js';
import { VbnRealtimeSource } from './sources/vbn-realtime.js';
import { VmzSource } from './sources/vmz.js';
import { parseBremenEventsHtml } from './sources/bremen-events.js';
import { LineHealthService } from './services/line-health.js';
import { ServiceNoticeService } from './services/service-notices.js';
import { ExternalImpactService } from './services/external-impacts.js';
import { ShiftBriefService } from './services/shift-brief.js';
import { assessRisk, DEFAULT_RISK_CONFIG } from './services/risk.js';
import { draftPassengerInformation } from './services/passenger-information.js';
import { createOperationsBriefingMcpServer } from './mcp/server.js';

const HTML_FETCH_POLICY: TextFetchPolicy = {
  expectedTypes: ['application/xhtml+xml', 'text/html', 'text/plain'],
  maxBytes: 2_000_000,
  timeoutMs: 10_000,
};

const runtimeEnvSchema = z.object({
  HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HTTP_BEARER_TOKEN: z.string().trim().min(1).optional(),
  HTTP_ALLOWED_ORIGINS: z.string().optional(),
  DATA_PATH: z.string().trim().min(1).optional(),
  BSAG_MCP_DATA_DIR: z.string().trim().min(1).optional(),
  CORRIDORS_PATH: z
    .string()
    .trim()
    .min(1)
    .default(resolve(process.cwd(), 'config/corridors.json')),
});

export interface ApplicationConfig {
  core: Readonly<EnvConfig>;
  http: {
    host: string;
    port: number;
    bearerToken?: string;
    allowedOrigins: string[];
  };
  paths: {
    corridorsPath: string;
    dataPath: string;
  };
}

export interface Application {
  config: Readonly<ApplicationConfig>;
  createMcpServer(): McpServer;
  readiness: {
    isReady(): boolean;
  };
  close(): Promise<void>;
}

export interface ApplicationOptions {
  clock?: Clock;
  corridorsPath?: string;
  dataPath?: string;
  dispatcher?: Dispatcher;
  env?: Record<string, string | undefined>;
  logger?: Logger;
  pdfExtractor?: (bytes: Uint8Array) => Promise<string>;
}

interface RuntimeEnvConfig {
  httpPort: number;
  httpBearerToken?: string;
  httpAllowedOrigins: string[];
  dataPath: string;
  corridorsPath: string;
}

export function createApplication(
  options: ApplicationOptions = {},
): Application {
  const envInput = options.env ?? process.env;
  const coreConfig = loadEnv(envInput);
  const runtimeConfig = loadRuntimeEnv(envInput, options);
  const logger = options.logger ?? defaultLogger;
  const clock = options.clock ?? new SystemClock();
  const corridors = loadCorridors(runtimeConfig.corridorsPath);

  mkdirSync(dirname(runtimeConfig.dataPath), { recursive: true });

  const database = openDatabase(runtimeConfig.dataPath);
  const repositories = createRepositories(database);
  const httpClient = new SourceHttpClient({
    allowedSourceUrls: [
      coreConfig.sources.vbnRealtimeJsonUrl,
      coreConfig.sources.vbnRealtimeProtobufUrl,
      coreConfig.sources.vbnNoticesUrl,
      coreConfig.sources.bsagNewsUrl,
      coreConfig.sources.vmzCurrentUrl,
      coreConfig.sources.vmzPreviewUrl,
      coreConfig.sources.vmzOverviewUrl,
      coreConfig.sources.vmzRssUrl,
      coreConfig.sources.bremenEventsUrl,
    ],
    logger,
    ...(options.dispatcher === undefined
      ? {}
      : { dispatcher: options.dispatcher }),
  });

  const lineHealthService = new LineHealthService({
    clock,
    repositories,
    retentionDays: coreConfig.retention.days,
    refreshIntervalSeconds: coreConfig.realtime.refreshIntervalSeconds,
    source: new VbnRealtimeSource({
      client: httpClient,
      jsonUrl: new URL(coreConfig.sources.vbnRealtimeJsonUrl),
      protobufUrl: new URL(coreConfig.sources.vbnRealtimeProtobufUrl),
      clock,
    }),
  });
  const serviceNoticesService = new ServiceNoticeService({
    clock,
    repositories,
    sources: [
      {
        sourceId: 'bsag',
        fetch: () =>
          fetchBsagNotices({
            client: httpClient,
            clock,
            url: new URL(coreConfig.sources.bsagNewsUrl),
          }),
      },
      {
        sourceId: 'vbn_notices',
        fetch: () =>
          fetchVbnNotices({
            client: httpClient,
            clock,
            url: new URL(coreConfig.sources.vbnNoticesUrl),
          }),
      },
    ],
  });
  const vmzSource = new VmzSource({
    client: httpClient,
    clock,
    currentUrl: new URL(coreConfig.sources.vmzCurrentUrl),
    overviewUrl: new URL(coreConfig.sources.vmzOverviewUrl),
    previewUrl: new URL(coreConfig.sources.vmzPreviewUrl),
    rssUrl: new URL(coreConfig.sources.vmzRssUrl),
    ...(options.pdfExtractor === undefined
      ? {}
      : { extractPdfText: options.pdfExtractor }),
  });
  const externalImpactsService = new ExternalImpactService({
    clock,
    corridors,
    repositories,
    sources: [
      {
        sourceIds: ['vmz_rss', 'vmz_web', 'vmz_pdf'],
        fetch: () => vmzSource.fetch(),
      },
      {
        sourceIds: ['bremen_events'],
        fetch: () =>
          fetchBremenEvents({
            client: httpClient,
            clock,
            url: new URL(coreConfig.sources.bremenEventsUrl),
          }),
      },
    ],
  });
  const shiftBriefService = new ShiftBriefService({
    assessRisk,
    clock,
    corridors,
    externalImpactsService,
    lineHealthService,
    passengerInformation: draftPassengerInformation,
    riskConfig: DEFAULT_RISK_CONFIG,
    serviceNoticesService,
  });

  let ready = true;
  let closePromise: Promise<void> | undefined;

  const config: Readonly<ApplicationConfig> = Object.freeze({
    core: coreConfig,
    http: {
      host: coreConfig.http.host,
      port: runtimeConfig.httpPort,
      ...(runtimeConfig.httpBearerToken === undefined
        ? {}
        : { bearerToken: runtimeConfig.httpBearerToken }),
      allowedOrigins: [...runtimeConfig.httpAllowedOrigins],
    },
    paths: {
      corridorsPath: runtimeConfig.corridorsPath,
      dataPath: runtimeConfig.dataPath,
    },
  });

  return {
    config,
    createMcpServer(): McpServer {
      return createOperationsBriefingMcpServer({
        clock,
        draftPassengerInformation,
        externalImpactsService,
        lineHealthService,
        serviceNoticesService,
        shiftBriefService,
      });
    },
    readiness: {
      isReady(): boolean {
        return ready;
      },
    },
    close(): Promise<void> {
      if (!closePromise) {
        closePromise = Promise.resolve().then(() => {
          ready = false;
          database.close();
        });
      }

      return closePromise;
    },
  };
}

function loadRuntimeEnv(
  input: Record<string, string | undefined>,
  options: ApplicationOptions,
): RuntimeEnvConfig {
  const parsed = runtimeEnvSchema.parse(input);

  return {
    httpPort: parsed.HTTP_PORT,
    ...(parsed.HTTP_BEARER_TOKEN === undefined
      ? {}
      : { httpBearerToken: parsed.HTTP_BEARER_TOKEN }),
    httpAllowedOrigins: splitOrigins(parsed.HTTP_ALLOWED_ORIGINS),
    dataPath:
      options.dataPath ??
      parsed.DATA_PATH ??
      (parsed.BSAG_MCP_DATA_DIR === undefined
        ? join(process.cwd(), 'data', 'bsag.sqlite')
        : join(parsed.BSAG_MCP_DATA_DIR, 'bsag.sqlite')),
    corridorsPath: options.corridorsPath ?? parsed.CORRIDORS_PATH,
  };
}

function splitOrigins(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function fetchBsagNotices(options: {
  client: SourceHttpClient;
  clock: Clock;
  url: URL;
}) {
  const fetchedAt = options.clock.now().toISOString();
  const response = await options.client.getText(options.url, HTML_FETCH_POLICY);

  return parseBsagNoticesHtml(response.body, response.finalUrl, fetchedAt);
}

async function fetchVbnNotices(options: {
  client: SourceHttpClient;
  clock: Clock;
  url: URL;
}) {
  const fetchedAt = options.clock.now().toISOString();
  const response = await options.client.getText(options.url, HTML_FETCH_POLICY);

  return parseVbnNoticesHtml(response.body, response.finalUrl, fetchedAt);
}

async function fetchBremenEvents(options: {
  client: SourceHttpClient;
  clock: Clock;
  url: URL;
}) {
  const fetchedAt = options.clock.now().toISOString();
  const response = await options.client.getText(options.url, HTML_FETCH_POLICY);

  return parseBremenEventsHtml(response.body, response.finalUrl, fetchedAt);
}
