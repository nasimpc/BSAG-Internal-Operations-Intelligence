import { AsyncLocalStorage } from 'node:async_hooks';

import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';

import type { SourceId } from '../domain/models.js';

export interface LogContext {
  requestId?: string;
  toolCallId?: string;
  sourceId?: SourceId;
  sourceDurationMs?: number;
  sourceRecordCount?: number;
}

const storage = new AsyncLocalStorage<Readonly<LogContext>>();
const EMPTY_CONTEXT: Readonly<LogContext> = Object.freeze({});

export function withLogContext<T>(context: LogContext, callback: () => T): T {
  const current = storage.getStore() ?? EMPTY_CONTEXT;

  return storage.run(
    {
      ...current,
      ...context,
    },
    callback,
  );
}

export function getLogContext(): Readonly<LogContext> {
  return storage.getStore() ?? EMPTY_CONTEXT;
}

export function createLogger(options?: {
  destination?: DestinationStream;
  level?: LoggerOptions['level'];
}): Logger {
  return pino(
    {
      level: options?.level ?? 'info',
      base: null,
      messageKey: 'message',
      formatters: {
        bindings: () => ({}),
        level: (label) => ({ level: label }),
      },
      mixin: () => ({ ...getLogContext() }),
    },
    options?.destination ?? pino.destination({ fd: 2, sync: true }),
  );
}

export const logger = createLogger();
