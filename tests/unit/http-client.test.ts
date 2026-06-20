import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAgent } from 'undici';

import {
  SourceHttpClient,
  type TextFetchPolicy,
} from '../../src/sources/http-client.js';

function createTextPolicy(
  overrides: Partial<TextFetchPolicy> = {},
): TextFetchPolicy {
  return {
    expectedTypes: ['text/plain'],
    maxBytes: 1024,
    timeoutMs: 250,
    ...overrides,
  };
}

const agents: MockAgent[] = [];

afterEach(async () => {
  while (agents.length > 0) {
    const agent = agents.pop();

    if (agent) {
      await agent.close();
    }
  }
});

describe('SourceHttpClient', () => {
  function createAgent(): MockAgent {
    const agent = new MockAgent({ enableCallHistory: true });
    agent.disableNetConnect();
    agents.push(agent);
    return agent;
  }

  it('returns text bodies for configured hosts, normalized mime types, and a user-agent header', async () => {
    const agent = createAgent();
    const configuredUrl = new URL('https://allowed.example/feed.txt');

    agent
      .get(configuredUrl.origin)
      .intercept({ path: '/feed.txt', method: 'GET' })
      .reply(200, '<main>ok</main>', {
        headers: { 'content-type': 'TEXT/HTML; charset=utf-8' },
      });

    const client = new SourceHttpClient({
      allowedSourceUrls: [configuredUrl.toString()],
      dispatcher: agent,
      sleeper: () => Promise.resolve(),
      jitter: () => 0,
    });

    const response = await client.getText(
      configuredUrl,
      createTextPolicy({ expectedTypes: ['text/html'] }),
    );

    expect(response).toMatchObject({
      body: '<main>ok</main>',
      finalUrl: configuredUrl,
      contentType: 'text/html',
    });
    expect(
      agent.getCallHistory()?.firstCall()?.headers?.['user-agent'],
    ).toContain('bsag-public-operations-briefing');
  });

  it('rejects requests whose host is not allow-listed with a machine-readable code', async () => {
    const agent = createAgent();
    const client = new SourceHttpClient({
      allowedSourceUrls: ['https://allowed.example/feed.txt'],
      dispatcher: agent,
      sleeper: () => Promise.resolve(),
      jitter: () => 0,
    });

    await expect(
      client.getText(
        new URL('https://denied.example/feed.txt'),
        createTextPolicy(),
      ),
    ).rejects.toMatchObject({
      code: 'HOST_NOT_ALLOWED',
    });
  });

  it('maps timeouts to a retryable source timeout error', async () => {
    const agent = createAgent();
    const url = new URL('https://allowed.example/slow');

    agent
      .get(url.origin)
      .intercept({ path: '/slow', method: 'GET' })
      .reply(200, '<main>slow</main>', {
        headers: { 'content-type': 'text/html' },
      })
      .delay(100)
      .persist();

    const client = new SourceHttpClient({
      allowedSourceUrls: [url.toString()],
      dispatcher: agent,
      sleeper: () => Promise.resolve(),
      jitter: () => 0,
    });

    await expect(
      client.getText(
        url,
        createTextPolicy({
          expectedTypes: ['text/html'],
          timeoutMs: 10,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'SOURCE_TIMEOUT',
      retryable: true,
    });
  });

  it('maps socket failures to retryable network errors and retries with the default sleeper', async () => {
    const agent = createAgent();
    const url = new URL('https://allowed.example/socket');
    const pool = agent.get(url.origin);

    pool
      .intercept({ path: '/socket', method: 'GET' })
      .replyWithError(new Error('socket hang up'));
    pool.intercept({ path: '/socket', method: 'GET' }).reply(200, 'ok', {
      headers: { 'content-type': 'text/plain' },
    });

    vi.useFakeTimers();

    try {
      const client = new SourceHttpClient({
        allowedSourceUrls: [url.toString()],
        dispatcher: agent,
        jitter: () => 0,
      });

      const responsePromise = client.getText(url, createTextPolicy());

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);

      const response = await responsePromise;

      expect(response).toMatchObject({
        body: 'ok',
        attempts: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries transient 503 responses and then succeeds', async () => {
    const agent = createAgent();
    const url = new URL('https://allowed.example/flaky');
    const sleepCalls: number[] = [];
    const pool = agent.get(url.origin);

    pool
      .intercept({ path: '/flaky', method: 'GET' })
      .reply(503, 'unavailable', {
        headers: { 'content-type': 'text/plain' },
      });
    pool.intercept({ path: '/flaky', method: 'GET' }).reply(200, 'ok', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });

    const client = new SourceHttpClient({
      allowedSourceUrls: [url.toString()],
      dispatcher: agent,
      sleeper: (delayMs) => {
        sleepCalls.push(delayMs);
        return Promise.resolve();
      },
      jitter: () => 0,
    });

    const response = await client.getText(url, createTextPolicy());

    expect(response.body).toBe('ok');
    expect(sleepCalls).toEqual([100]);
    const callHistory = agent.getCallHistory();

    expect(callHistory).toBeDefined();
    expect(
      callHistory
        ? callHistory.calls().filter((call) => call.path === '/flaky')
        : undefined,
    ).toHaveLength(2);
  });

  it('does not retry non-transient 404 responses', async () => {
    const agent = createAgent();
    const url = new URL('https://allowed.example/missing');

    agent
      .get(url.origin)
      .intercept({ path: '/missing', method: 'GET' })
      .reply(404, 'missing', {
        headers: { 'content-type': 'text/plain' },
      });

    const client = new SourceHttpClient({
      allowedSourceUrls: [url.toString()],
      dispatcher: agent,
      sleeper: () => Promise.resolve(),
      jitter: () => 0,
    });

    await expect(client.getText(url, createTextPolicy())).rejects.toMatchObject(
      {
        code: 'SOURCE_HTTP_STATUS',
        statusCode: 404,
      },
    );

    const callHistory = agent.getCallHistory();

    expect(callHistory).toBeDefined();
    expect(
      callHistory
        ? callHistory.calls().filter((call) => call.path === '/missing')
        : undefined,
    ).toHaveLength(1);
  });

  it('rejects unexpected content types after normalization', async () => {
    const agent = createAgent();
    const url = new URL('https://allowed.example/rss');

    agent
      .get(url.origin)
      .intercept({ path: '/rss', method: 'GET' })
      .reply(200, '<rss />', {
        headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
      });

    const client = new SourceHttpClient({
      allowedSourceUrls: [url.toString()],
      dispatcher: agent,
      sleeper: () => Promise.resolve(),
      jitter: () => 0,
    });

    await expect(
      client.getText(url, createTextPolicy({ expectedTypes: ['text/html'] })),
    ).rejects.toMatchObject({
      code: 'SOURCE_CONTENT_TYPE',
    });
  });

  it('rejects declared content-length values that exceed the byte limit before reading the body', async () => {
    const agent = createAgent();
    const url = new URL('https://allowed.example/large-header');

    agent
      .get(url.origin)
      .intercept({ path: '/large-header', method: 'GET' })
      .reply(200, 'abc', {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': '10',
        },
      });

    const client = new SourceHttpClient({
      allowedSourceUrls: [url.toString()],
      dispatcher: agent,
      sleeper: () => Promise.resolve(),
      jitter: () => 0,
    });

    await expect(
      client.getBytes(url, {
        expectedTypes: ['application/octet-stream'],
        maxBytes: 3,
        timeoutMs: 250,
      }),
    ).rejects.toMatchObject({
      code: 'SOURCE_RESPONSE_TOO_LARGE',
    });
  });

  it('rejects streamed bodies that exceed the configured byte limit', async () => {
    const agent = createAgent();
    const url = new URL('https://allowed.example/large-stream');

    agent
      .get(url.origin)
      .intercept({ path: '/large-stream', method: 'GET' })
      .reply(200, 'abcdef', {
        headers: { 'content-type': 'application/octet-stream' },
      });

    const client = new SourceHttpClient({
      allowedSourceUrls: [url.toString()],
      dispatcher: agent,
      sleeper: () => Promise.resolve(),
      jitter: () => 0,
    });

    await expect(
      client.getBytes(url, {
        expectedTypes: ['application/octet-stream'],
        maxBytes: 3,
        timeoutMs: 250,
      }),
    ).rejects.toMatchObject({
      code: 'SOURCE_RESPONSE_TOO_LARGE',
    });
  });

  it('follows allow-listed redirects whose location header is an array', async () => {
    const agent = createAgent();
    const url = new URL('https://allowed.example/redirect');
    const finalUrl = new URL('https://allowed.example/final');
    const pool = agent.get(url.origin);

    pool.intercept({ path: '/redirect', method: 'GET' }).reply(302, '', {
      headers: { location: [finalUrl.toString()] },
    });
    pool.intercept({ path: '/final', method: 'GET' }).reply(200, 'done', {
      headers: { 'content-type': 'text/plain' },
    });

    const client = new SourceHttpClient({
      allowedSourceUrls: [url.toString()],
      dispatcher: agent,
      sleeper: () => Promise.resolve(),
      jitter: () => 0,
    });

    const response = await client.getText(url, createTextPolicy());

    expect(response).toMatchObject({
      body: 'done',
      finalUrl,
      redirectCount: 1,
    });
  });

  it('rejects redirect responses that omit a location header', async () => {
    const agent = createAgent();
    const url = new URL('https://allowed.example/missing-location');

    agent
      .get(url.origin)
      .intercept({ path: '/missing-location', method: 'GET' })
      .reply(302, '', { headers: {} });

    const client = new SourceHttpClient({
      allowedSourceUrls: [url.toString()],
      dispatcher: agent,
      sleeper: () => Promise.resolve(),
      jitter: () => 0,
    });

    await expect(client.getText(url, createTextPolicy())).rejects.toMatchObject(
      {
        code: 'SOURCE_REDIRECT_LOCATION_MISSING',
      },
    );
  });

  it('rejects responses that exceed the configured redirect limit', async () => {
    const agent = createAgent();
    const url = new URL('https://allowed.example/redirect-limit');

    agent
      .get(url.origin)
      .intercept({ path: '/redirect-limit', method: 'GET' })
      .reply(302, '', {
        headers: { location: 'https://allowed.example/final' },
      });

    const client = new SourceHttpClient({
      allowedSourceUrls: [url.toString()],
      dispatcher: agent,
      sleeper: () => Promise.resolve(),
      jitter: () => 0,
      maxRedirects: 0,
    });

    await expect(client.getText(url, createTextPolicy())).rejects.toMatchObject(
      {
        code: 'SOURCE_TOO_MANY_REDIRECTS',
      },
    );
  });

  it('rejects redirects that leave the configured allow-list', async () => {
    const agent = createAgent();
    const url = new URL('https://allowed.example/escape');

    agent
      .get(url.origin)
      .intercept({ path: '/escape', method: 'GET' })
      .reply(302, '', {
        headers: { location: 'https://denied.example/blocked' },
      });

    const client = new SourceHttpClient({
      allowedSourceUrls: [url.toString()],
      dispatcher: agent,
      sleeper: () => Promise.resolve(),
      jitter: () => 0,
    });

    await expect(client.getText(url, createTextPolicy())).rejects.toMatchObject(
      {
        code: 'REDIRECT_HOST_NOT_ALLOWED',
      },
    );
  });
});
