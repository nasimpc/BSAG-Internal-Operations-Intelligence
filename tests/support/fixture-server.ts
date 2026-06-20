import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORRIDORS_PATH = fileURLToPath(
  new URL('../../config/corridors.json', import.meta.url),
);

const FIXTURES = {
  '/vbn-realtime.json': {
    body: readFileSync(
      new URL('../fixtures/vbn-realtime.json', import.meta.url),
    ),
    contentType: 'application/json',
  },
  '/vbn-realtime.bin': {
    body: Buffer.from('placeholder'),
    contentType: 'application/octet-stream',
  },
  '/vbn-notices': {
    body: readFileSync(
      new URL('../fixtures/vbn-notices.html', import.meta.url),
    ),
    contentType: 'text/html',
  },
  '/bsag-news': {
    body: readFileSync(new URL('../fixtures/bsag-news.html', import.meta.url)),
    contentType: 'text/html',
  },
  '/vmz/current': {
    body: readFileSync(
      new URL('../fixtures/vmz-roadworks.html', import.meta.url),
    ),
    contentType: 'text/html',
  },
  '/vmz/preview': {
    body: readFileSync(
      new URL('../fixtures/vmz-roadworks.html', import.meta.url),
    ),
    contentType: 'text/html',
  },
  '/vmz/overview': {
    body: readFileSync(
      new URL('../fixtures/vmz-roadworks.html', import.meta.url),
    ),
    contentType: 'text/html',
  },
  '/vmz/feed.rss': {
    body: readFileSync(new URL('../fixtures/vmz-feed.xml', import.meta.url)),
    contentType: 'application/rss+xml',
  },
  '/bremen-events': {
    body: readFileSync(
      new URL('../fixtures/bremen-events.html', import.meta.url),
    ),
    contentType: 'text/html',
  },
  '/media/verkehr/baustellenpresse/baustellenpresse_kw25.pdf': {
    body: Buffer.from('%PDF-1.4\n% fixture\n'),
    contentType: 'application/pdf',
  },
  '/media/verkehr/sondermeldung.pdf': {
    body: Buffer.from('%PDF-1.4\n% fixture\n'),
    contentType: 'application/pdf',
  },
} as const;

export interface FixtureServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const server = createServer((request, response) => {
    const path = request.url ?? '/';

    if (!(path in FIXTURES)) {
      response.writeHead(404).end('not found');
      return;
    }

    const fixture = FIXTURES[path as keyof typeof FIXTURES];

    response.writeHead(200, {
      'content-type': fixture.contentType,
      'content-length': String(fixture.body.byteLength),
    });
    response.end(fixture.body);
  });

  await listen(server);

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Fixture server did not bind to a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: () => closeServer(server),
  };
}

export function buildTestEnv(
  baseUrl: string,
  dataPath: string,
  options: {
    includeCorridorsPath?: boolean;
  } = {},
): Record<string, string> {
  const env: Record<string, string> = {
    TZ: 'Europe/Berlin',
    HTTP_HOST: '127.0.0.1',
    BSAG_MCP_DATA_DIR: dirname(dataPath),
    DATA_PATH: dataPath,
    VBN_REALTIME_JSON_URL: `${baseUrl}/vbn-realtime.json`,
    VBN_REALTIME_PROTOBUF_URL: `${baseUrl}/vbn-realtime.bin`,
    VBN_NOTICES_URL: `${baseUrl}/vbn-notices`,
    BSAG_NEWS_URL: `${baseUrl}/bsag-news`,
    VMZ_CURRENT_URL: `${baseUrl}/vmz/current`,
    VMZ_PREVIEW_URL: `${baseUrl}/vmz/preview`,
    VMZ_OVERVIEW_URL: `${baseUrl}/vmz/overview`,
    VMZ_RSS_URL: `${baseUrl}/vmz/feed.rss`,
    BREMEN_EVENTS_URL: `${baseUrl}/bremen-events`,
  };

  if (options.includeCorridorsPath !== false) {
    env.CORRIDORS_PATH = resolve(CORRIDORS_PATH);
  }

  return env;
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
