import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/spec.types.js';
import { describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApplication } from '../../src/app.js';
import type { Application } from '../../src/app.js';
import { createLogger } from '../../src/shared/logger.js';
import { createHttpApp } from '../../src/transports/http.js';
import { FixedClock } from '../../src/shared/clock.js';
import { buildTestEnv, startFixtureServer } from '../support/fixture-server.js';

describe('http transport', () => {
  it('serves live health and reflects application readiness', async () => {
    const readyApplication = fakeApplication(true);
    const readyApp = createHttpApp({
      application: readyApplication,
      host: '127.0.0.1',
      logger: createLogger({ level: 'silent' }),
    });

    await request(readyApp).get('/health/live').expect(200, {
      status: 'ok',
    });
    await request(readyApp).get('/health/ready').expect(200, {
      status: 'ready',
    });

    const notReadyApplication = fakeApplication(false);
    const notReadyApp = createHttpApp({
      application: notReadyApplication,
      host: '127.0.0.1',
      logger: createLogger({ level: 'silent' }),
    });

    await request(notReadyApp).get('/health/ready').expect(503, {
      status: 'not_ready',
    });
  });

  it('returns protocol-shaped 405s, rejects disallowed origins, and enforces the 1 MiB json limit', async () => {
    const fixtureServer = await startFixtureServer();
    const directory = mkdtempSync(join(tmpdir(), 'bsag-http-security-'));
    const dataPath = join(directory, 'storage.sqlite');
    const application = createApplication({
      clock: new FixedClock(new Date('2026-06-20T06:00:00.000Z')),
      dataPath,
      env: buildTestEnv(fixtureServer.baseUrl, dataPath),
      logger: createLogger({ level: 'silent' }),
      pdfExtractor: () => Promise.resolve(''),
    });
    const app = createHttpApp({
      application,
      host: '127.0.0.1',
      logger: createLogger({ level: 'silent' }),
    });

    try {
      await request(app)
        .get('/mcp')
        .expect(405)
        .expect({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Method not allowed.',
          },
          id: null,
        });

      await request(app)
        .delete('/mcp')
        .expect(405)
        .expect({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Method not allowed.',
          },
          id: null,
        });

      await request(app)
        .post('/mcp')
        .set('Origin', 'https://evil.example')
        .set('Accept', 'application/json')
        .set('MCP-Protocol-Version', LATEST_PROTOCOL_VERSION)
        .send(initializeRequest())
        .expect(403);

      await request(app)
        .post('/mcp')
        .set('content-type', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 99,
          method: 'initialize',
          params: {
            ...initializeRequest().params,
            huge: 'x'.repeat(1_100_000),
          },
        })
        .expect(413);
    } finally {
      await application.close();
      await fixtureServer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails startup on non-loopback host when no bearer token is configured', () => {
    const application = fakeApplication(true);

    expect(() =>
      createHttpApp({
        application,
        host: '0.0.0.0',
        logger: createLogger({ level: 'silent' }),
      }),
    ).toThrow(/bearer/i);
  });

  it('handles initialize and draft tool calls and enforces bearer outcomes', async () => {
    const fixtureServer = await startFixtureServer();
    const directory = mkdtempSync(join(tmpdir(), 'bsag-http-mcp-'));
    const dataPath = join(directory, 'storage.sqlite');
    const application = createApplication({
      clock: new FixedClock(new Date('2026-06-20T06:00:00.000Z')),
      dataPath,
      env: {
        ...buildTestEnv(fixtureServer.baseUrl, dataPath),
        HTTP_BEARER_TOKEN: 'topsecret',
      },
      logger: createLogger({ level: 'silent' }),
      pdfExtractor: () => Promise.resolve(''),
    });
    const app = createHttpApp({
      application,
      host: '127.0.0.1',
      bearerToken: 'topsecret',
      logger: createLogger({ level: 'silent' }),
    });
    const server = createServer(app);

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          resolve();
        });
      });

      const address = server.address();

      if (address === null || typeof address === 'string') {
        throw new Error('HTTP server did not bind to a TCP port');
      }

      await request(app)
        .post('/mcp')
        .set('Authorization', 'Bearer topsecret')
        .set('Accept', 'application/json, text/event-stream')
        .set('MCP-Protocol-Version', LATEST_PROTOCOL_VERSION)
        .send(initializeRequest())
        .expect(200)
        .expect((response) => {
          expect(response.headers['content-type']).toMatch(
            /application\/json|text\/event-stream/i,
          );
        });

      await request(app)
        .post('/mcp')
        .set('Authorization', 'Bearer wrong')
        .set('Accept', 'application/json')
        .set('MCP-Protocol-Version', LATEST_PROTOCOL_VERSION)
        .send(initializeRequest())
        .expect(401);

      const client = new Client(
        {
          name: 'bsag-http-test-client',
          version: '0.0.0',
        },
        {
          capabilities: {},
        },
      );
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${String(address.port)}/mcp`),
        {
          requestInit: {
            headers: {
              Authorization: 'Bearer topsecret',
            },
          },
        },
      );

      await client.connect(transport as Parameters<typeof client.connect>[0]);

      const result = await client.callTool({
        name: 'draft_passenger_information',
        arguments: {
          line_ids: ['10'],
          issue_summary:
            'Roadworks may affect the eastern corridor tomorrow morning.',
          channel: 'app',
        },
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        status: 'complete',
        data: {
          channel: 'app',
        },
      });

      await client.close();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
      await application.close();
      await fixtureServer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function fakeApplication(ready: boolean): Application {
  return {
    config: {
      core: {
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
          vbnRealtimeJsonUrl: 'http://127.0.0.1/realtime.json',
          vbnRealtimeProtobufUrl: 'http://127.0.0.1/realtime.bin',
          vbnNoticesUrl: 'http://127.0.0.1/vbn-notices',
          bsagNewsUrl: 'http://127.0.0.1/bsag-news',
          vmzCurrentUrl: 'http://127.0.0.1/vmz/current',
          vmzPreviewUrl: 'http://127.0.0.1/vmz/preview',
          vmzOverviewUrl: 'http://127.0.0.1/vmz/overview',
          vmzRssUrl: 'http://127.0.0.1/vmz/feed.rss',
          bremenEventsUrl: 'http://127.0.0.1/bremen-events',
        },
      },
      http: {
        host: '127.0.0.1',
        port: 3000,
        allowedOrigins: [],
      },
      paths: {
        corridorsPath: '/tmp/corridors.json',
        dataPath: '/tmp/storage.sqlite',
      },
    },
    createMcpServer() {
      throw new Error(
        'MCP server should not be created in this health-only test',
      );
    },
    readiness: {
      isReady: () => ready,
    },
    close: () => Promise.resolve(),
  };
}

function initializeRequest() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'bsag-http-test-client',
        version: '0.0.0',
      },
    },
  };
}
