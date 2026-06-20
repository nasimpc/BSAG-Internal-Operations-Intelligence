import { Buffer } from 'node:buffer';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  createLogger,
  getLogContext,
  withLogContext,
} from '../../src/shared/logger.js';

describe('logger', () => {
  it('writes newline-delimited JSON entries with async-local context', () => {
    const destination = new PassThrough();
    const chunks: string[] = [];
    destination.on('data', (chunk: Buffer | string) => {
      chunks.push(
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
      );
    });

    const logger = createLogger({ destination });

    withLogContext(
      {
        requestId: 'req-123',
        toolCallId: 'tool-456',
        sourceDurationMs: 87,
        sourceRecordCount: 12,
      },
      () => {
        logger.info({ event: 'source_fetch' }, 'fetched source');
      },
    );

    const entry = JSON.parse(chunks.join('').trim()) as Record<string, unknown>;

    expect(entry).toMatchObject({
      level: 'info',
      message: 'fetched source',
      event: 'source_fetch',
      requestId: 'req-123',
      toolCallId: 'tool-456',
      sourceDurationMs: 87,
      sourceRecordCount: 12,
    });
  });

  it('merges nested async-local context without leaking outside the scope', async () => {
    await withLogContext({ requestId: 'req-outer' }, async () => {
      expect(getLogContext()).toMatchObject({ requestId: 'req-outer' });

      await withLogContext({ toolCallId: 'tool-inner' }, async () => {
        await Promise.resolve();

        expect(getLogContext()).toMatchObject({
          requestId: 'req-outer',
          toolCallId: 'tool-inner',
        });
      });

      await Promise.resolve();

      expect(getLogContext()).toMatchObject({ requestId: 'req-outer' });
      expect(getLogContext().toolCallId).toBeUndefined();
    });

    expect(getLogContext()).toEqual({});
  });
});
