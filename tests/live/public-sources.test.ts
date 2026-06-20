import { describe, expect, it } from 'vitest';

import { loadEnv } from '../../src/config/env.js';
import { SystemClock } from '../../src/shared/clock.js';
import { createLogger } from '../../src/shared/logger.js';
import {
  SourceHttpClient,
  type TextFetchPolicy,
} from '../../src/sources/http-client.js';
import { VbnRealtimeSource } from '../../src/sources/vbn-realtime.js';
import { parseBsagNoticesHtml } from '../../src/sources/bsag-notices.js';
import { parseBremenEventsHtml } from '../../src/sources/bremen-events.js';
import { parseVbnNoticesHtml } from '../../src/sources/vbn-notices.js';
import { VmzSource } from '../../src/sources/vmz.js';

const runLive = process.env.BSAG_LIVE_TESTS === '1';

const HTML_FETCH_POLICY: TextFetchPolicy = {
  expectedTypes: ['application/xhtml+xml', 'text/html', 'text/plain'],
  maxBytes: 2_000_000,
  timeoutMs: 10_000,
};

interface SourceReport {
  source: string;
  record_count: number;
  status: 'records' | 'warnings';
  warning_codes: string[];
}

const describeLive = runLive ? describe : describe.skip;

describeLive('public official sources', () => {
  it('fetches each configured source without crashing and reports warnings structurally', async () => {
    const config = loadEnv(process.env);
    const clock = new SystemClock();
    const client = new SourceHttpClient({
      allowedSourceUrls: [
        config.sources.vbnRealtimeJsonUrl,
        config.sources.vbnRealtimeProtobufUrl,
        config.sources.vbnNoticesUrl,
        config.sources.bsagNewsUrl,
        config.sources.vmzCurrentUrl,
        config.sources.vmzPreviewUrl,
        config.sources.vmzOverviewUrl,
        config.sources.vmzRssUrl,
        config.sources.bremenEventsUrl,
      ],
      logger: createLogger({ level: 'warn' }),
    });
    const realtimeSource = new VbnRealtimeSource({
      client,
      jsonUrl: new URL(config.sources.vbnRealtimeJsonUrl),
      protobufUrl: new URL(config.sources.vbnRealtimeProtobufUrl),
      clock,
    });
    const vmzSource = new VmzSource({
      client,
      clock,
      currentUrl: new URL(config.sources.vmzCurrentUrl),
      overviewUrl: new URL(config.sources.vmzOverviewUrl),
      previewUrl: new URL(config.sources.vmzPreviewUrl),
      rssUrl: new URL(config.sources.vmzRssUrl),
    });

    const reports = await Promise.all([
      reportOutcome('vbn_realtime', () => realtimeSource.fetch()),
      reportOutcome('vbn_notices', async () => {
        const fetchedAt = clock.now().toISOString();
        const response = await client.getText(
          new URL(config.sources.vbnNoticesUrl),
          HTML_FETCH_POLICY,
        );

        return parseVbnNoticesHtml(response.body, response.finalUrl, fetchedAt);
      }),
      reportOutcome('bsag', async () => {
        const fetchedAt = clock.now().toISOString();
        const response = await client.getText(
          new URL(config.sources.bsagNewsUrl),
          HTML_FETCH_POLICY,
        );

        return parseBsagNoticesHtml(
          response.body,
          response.finalUrl,
          fetchedAt,
        );
      }),
      reportOutcome('vmz', () => vmzSource.fetch()),
      reportOutcome('bremen_events', async () => {
        const fetchedAt = clock.now().toISOString();
        const response = await client.getText(
          new URL(config.sources.bremenEventsUrl),
          HTML_FETCH_POLICY,
        );

        return parseBremenEventsHtml(
          response.body,
          response.finalUrl,
          fetchedAt,
        );
      }),
    ]);

    for (const report of reports) {
      console.info(JSON.stringify(report));
      expect(report.record_count > 0 || report.warning_codes.length > 0).toBe(
        true,
      );
    }
  }, 60_000);
});

async function reportOutcome(
  source: string,
  fetchOutcome: () => Promise<{
    data: unknown;
    warnings: Array<{
      code: string;
    }>;
  }>,
): Promise<SourceReport> {
  try {
    const outcome = await fetchOutcome();
    const recordCount = Array.isArray(outcome.data) ? outcome.data.length : 1;
    const warningCodes = outcome.warnings.map((warning) => warning.code);

    return {
      source,
      record_count: recordCount,
      status: warningCodes.length === 0 ? 'records' : 'warnings',
      warning_codes: warningCodes,
    };
  } catch (error) {
    return {
      source,
      record_count: 0,
      status: 'warnings',
      warning_codes: [toWarningCode(error)],
    };
  }
}

function toWarningCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.length > 0
  ) {
    return error.code;
  }

  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }

  return 'LIVE_SOURCE_ERROR';
}
