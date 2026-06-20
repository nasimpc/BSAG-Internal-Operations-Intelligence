import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

import express, { type ErrorRequestHandler, type Express } from 'express';
import type { Logger } from 'pino';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createApplication, type Application } from '../app.js';
import { logger as defaultLogger } from '../shared/logger.js';
import { InputError } from '../shared/dates.js';

const ONE_MIB = 1_048_576;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

export interface HttpTransportOptions {
  application: Application;
  allowedOrigins?: string[];
  bearerToken?: string;
  host?: string;
  jsonLimitBytes?: number;
  logger?: Logger;
}

export function createHttpApp(options: HttpTransportOptions): Express {
  const host = options.host ?? options.application.config.http.host;
  const bearerToken =
    options.bearerToken ?? options.application.config.http.bearerToken;
  const allowedOrigins =
    options.allowedOrigins ?? options.application.config.http.allowedOrigins;

  assertSecureHostConfiguration(host, bearerToken);

  const app = createMcpExpressApp({ host });
  const logger = options.logger ?? defaultLogger;
  const jsonLimitBytes = options.jsonLimitBytes ?? ONE_MIB;

  app.use(express.json({ limit: jsonLimitBytes }));
  app.use((request, response, next) => {
    const origin = request.get('origin');

    if (
      origin !== undefined &&
      !isOriginAllowed(origin, host, allowedOrigins)
    ) {
      response.status(403).json({
        error: 'Origin not allowed',
      });
      return;
    }

    next();
  });

  app.get('/health/live', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });

  app.get('/health/ready', (_request, response) => {
    if (options.application.readiness.isReady()) {
      response.status(200).json({ status: 'ready' });
      return;
    }

    response.status(503).json({ status: 'not_ready' });
  });

  app.all('/mcp', (request, response, next) => {
    if (request.method === 'POST') {
      next();
      return;
    }

    response.status(405).json(methodNotAllowedError());
  });

  app.post('/mcp', (request, response, next) => {
    if (
      bearerToken !== undefined &&
      !hasValidBearerToken(request.get('authorization'), bearerToken)
    ) {
      response
        .status(401)
        .set('www-authenticate', 'Bearer')
        .json({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'Unauthorized.',
          },
          id: null,
        });
      return;
    }

    next();
  });

  app.post('/mcp', async (request, response) => {
    const server = options.application.createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    } as unknown as ConstructorParameters<
      typeof StreamableHTTPServerTransport
    >[0]);
    const cleanup = once(async () => {
      await Promise.allSettled([transport.close(), server.close()]);
    });

    response.on('close', () => {
      void cleanup();
    });

    try {
      await server.connect(transport as Parameters<typeof server.connect>[0]);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      logger.error({
        event: 'mcp_http_request_failed',
        error: error instanceof Error ? error.message : String(error),
      });

      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    } finally {
      if (response.writableEnded) {
        void cleanup();
      }
    }
  });

  app.use(jsonErrorHandler(jsonLimitBytes));

  return app;
}

export async function runHttpServer(options?: {
  application?: Application;
}): Promise<Server> {
  const application = options?.application ?? createApplication();
  const app = createHttpApp({
    application,
    host: application.config.http.host,
    allowedOrigins: application.config.http.allowedOrigins,
    ...(application.config.http.bearerToken === undefined
      ? {}
      : { bearerToken: application.config.http.bearerToken }),
  });
  const server = createServer(app);
  const shutdown = installShutdown(server, application);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(
      application.config.http.port,
      application.config.http.host,
      () => {
        server.off('error', reject);
        resolve();
      },
    );
  });

  server.on('close', () => {
    shutdown.dispose();
  });

  return server;
}

async function main(): Promise<void> {
  try {
    await runHttpServer();
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

function assertSecureHostConfiguration(
  host: string,
  bearerToken: string | undefined,
): void {
  if (!LOOPBACK_HOSTS.has(host) && bearerToken === undefined) {
    throw new InputError(
      'HTTP_BEARER_TOKEN is required when binding HTTP to a non-loopback host',
    );
  }
}

function isOriginAllowed(
  origin: string,
  host: string,
  configuredAllowedOrigins: readonly string[],
): boolean {
  try {
    const parsed = new URL(origin);
    const normalizedOrigin = parsed.origin.toLowerCase();
    const originHost = parsed.hostname.toLowerCase();
    const allowedOrigins = new Set<string>();
    const allowedHosts = new Set<string>([host.toLowerCase()]);

    for (const value of configuredAllowedOrigins) {
      try {
        allowedOrigins.add(new URL(value).origin.toLowerCase());
      } catch {
        allowedHosts.add(value.toLowerCase());
      }
    }

    if (LOOPBACK_HOSTS.has(host)) {
      allowedHosts.add('127.0.0.1');
      allowedHosts.add('localhost');
      allowedHosts.add('::1');
    }

    return allowedOrigins.has(normalizedOrigin) || allowedHosts.has(originHost);
  } catch {
    return false;
  }
}

function hasValidBearerToken(
  authorizationHeader: string | undefined,
  expectedToken: string,
): boolean {
  if (
    authorizationHeader === undefined ||
    !authorizationHeader.startsWith('Bearer ')
  ) {
    return false;
  }

  const providedToken = authorizationHeader.slice('Bearer '.length);
  const expected = Buffer.from(expectedToken, 'utf8');
  const provided = Buffer.from(providedToken, 'utf8');
  const maxLength = Math.max(expected.length, provided.length);
  const expectedPadded = Buffer.alloc(maxLength);
  const providedPadded = Buffer.alloc(maxLength);

  expected.copy(expectedPadded);
  provided.copy(providedPadded);

  return (
    timingSafeEqual(expectedPadded, providedPadded) &&
    expected.length === provided.length
  );
}

function jsonErrorHandler(limitBytes: number): ErrorRequestHandler {
  return (error, _request, response, next) => {
    if (error === undefined || error === null) {
      next();
      return;
    }

    if (isEntityTooLargeError(error)) {
      response.status(413).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: `Request body must be ${String(limitBytes)} bytes or smaller.`,
        },
        id: null,
      });
      return;
    }

    if (error instanceof SyntaxError) {
      response.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32700,
          message: 'Invalid JSON.',
        },
        id: null,
      });
      return;
    }

    next(error);
  };
}

function isEntityTooLargeError(
  error: unknown,
): error is { type: 'entity.too.large' } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    (error as { type?: unknown }).type === 'entity.too.large'
  );
}

function methodNotAllowedError() {
  return {
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'Method not allowed.',
    },
    id: null,
  };
}

function once<T>(callback: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;

  return () => {
    promise ??= callback();
    return promise;
  };
}

function installShutdown(
  server: Server,
  application: Application,
): {
  dispose(): void;
} {
  let closed = false;

  const handler = (signal: NodeJS.Signals) => {
    if (closed) {
      return;
    }

    closed = true;
    server.close(() => {
      void application.close().finally(() => {
        process.exit(signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1);
      });
    });
  };

  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);

  return {
    dispose(): void {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
    },
  };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
