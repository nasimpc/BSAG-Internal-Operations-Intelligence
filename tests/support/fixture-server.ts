import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = '/home/nasimpcm/Desktop/BSAG-MCP/.worktrees/bsag-briefing-server';

const FIXTURES = {
  '/vbn-realtime.json': {
    body: readFileSync(resolve(ROOT, 'tests/fixtures/vbn-realtime.json')),
    contentType: 'application/json',
  },
  '/vbn-realtime.bin': {
    body: Buffer.from('placeholder'),
    contentType: 'application/octet-stream',
  },
  '/vbn-notices': {
    body: readFileSync(resolve(ROOT, 'tests/fixtures/vbn-notices.html')),
    contentType: 'text/html',
  },
  '/bsag-news': {
    body: readFileSync(resolve(ROOT, 'tests/fixtures/bsag-news.html')),
    contentType: 'text/html',
  },
  '/vmz/current': {
    body: readFileSync(resolve(ROOT, 'tests/fixtures/vmz-roadworks.html')),
    contentType: 'text/html',
  },
  '/vmz/preview': {
    body: readFileSync(resolve(ROOT, 'tests/fixtures/vmz-roadworks.html')),
    contentType: 'text/html',
  },
  '/vmz/overview': {
    body: readFileSync(resolve(ROOT, 'tests/fixtures/vmz-roadworks.html')),
    contentType: 'text/html',
  },
  '/vmz/feed.rss': {
    body: readFileSync(resolve(ROOT, 'tests/fixtures/vmz-feed.xml')),
    contentType: 'application/rss+xml',
  },
  '/bremen-events': {
    body: readFileSync(resolve(ROOT, 'tests/fixtures/bremen-events.html')),
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

export function buildTestEnv(baseUrl: string, dataPath: string): Record<string, string> {
  return {
    TZ: 'Europe/Berlin',
    HTTP_HOST: '127.0.0.1',
    DATA_PATH: dataPath,
    CORRIDORS_PATH: resolve(ROOT, 'config/corridors.json'),
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
