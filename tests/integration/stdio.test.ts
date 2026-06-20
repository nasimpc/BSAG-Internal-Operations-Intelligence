import Database from 'better-sqlite3';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { createApplication } from '../../src/app.js';
import { createLogger } from '../../src/shared/logger.js';
import { FixedClock } from '../../src/shared/clock.js';
import { buildTestEnv, startFixtureServer } from '../support/fixture-server.js';

const ROOT = '/home/nasimpcm/Desktop/BSAG-MCP/.worktrees/bsag-briefing-server';

describe('stdio transport', () => {
  it('creates the application lifecycle and toggles readiness on close without fetching public data', async () => {
    const fixtureServer = await startFixtureServer();
    const directory = mkdtempSync(join(tmpdir(), 'bsag-app-'));
    const dataPath = join(directory, 'storage.sqlite');
    const application = createApplication({
      clock: new FixedClock(new Date('2026-06-20T06:00:00.000Z')),
      dataPath,
      env: buildTestEnv(fixtureServer.baseUrl, dataPath),
      logger: createLogger({ level: 'silent' }),
      pdfExtractor: () => Promise.resolve(''),
    });

    try {
      expect(application.readiness.isReady()).toBe(true);

      const server = application.createMcpServer();

      await server.close();
      await application.close();

      expect(application.readiness.isReady()).toBe(false);
    } finally {
      await fixtureServer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('spawns the built stdio entry, lists tools, and calls draft_passenger_information without stdout pollution', async () => {
    const fixtureServer = await startFixtureServer();
    const directory = mkdtempSync(join(tmpdir(), 'bsag-stdio-'));
    const dataPath = join(directory, 'storage.sqlite');
    const childEnv = buildChildEnv(
      buildTestEnv(fixtureServer.baseUrl, dataPath),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(ROOT, 'dist/transports/stdio.js')],
      cwd: ROOT,
      env: childEnv,
      stderr: 'pipe',
    });
    const client = new Client(
      {
        name: 'bsag-stdio-test-client',
        version: '0.0.0',
      },
      {
        capabilities: {},
      },
    );

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      const result = await client.callTool({
        name: 'draft_passenger_information',
        arguments: {
          line_ids: ['10'],
          issue_summary:
            'Roadworks may affect the eastern corridor tomorrow morning.',
          channel: 'app',
        },
      });

      expect(tools.tools.map((tool) => tool.name)).toContain(
        'draft_passenger_information',
      );
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        status: 'complete',
        data: {
          channel: 'app',
          manual_edit_required: false,
        },
      });
    } finally {
      await client.close();
      await fixtureServer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('exits with code 0 on SIGTERM after opening the sqlite database', async () => {
    const fixtureServer = await startFixtureServer();
    const directory = mkdtempSync(join(tmpdir(), 'bsag-stdio-exit-'));
    const dataPath = join(directory, 'storage.sqlite');
    const childEnv = buildChildEnv(
      buildTestEnv(fixtureServer.baseUrl, dataPath),
    );
    const child = spawn(
      process.execPath,
      [resolve(ROOT, 'dist/transports/stdio.js')],
      {
        cwd: ROOT,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    try {
      await waitFor(() => existsSync(dataPath), 15_000);
      await new Promise((resolve) => setTimeout(resolve, 250));

      child.kill('SIGTERM');

      const exit = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolvePromise, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
          resolvePromise({ code, signal });
        });
      });

      expect(exit).toEqual({
        code: 0,
        signal: null,
      });

      const database = new Database(dataPath);

      database.close();
    } finally {
      if (!child.killed) {
        child.kill('SIGKILL');
      }

      await fixtureServer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('Timed out waiting for predicate');
}

function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...extra,
  };
}
