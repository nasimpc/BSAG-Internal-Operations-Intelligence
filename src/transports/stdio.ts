import { pathToFileURL } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createApplication, type Application } from '../app.js';

export interface StdioTransportOptions {
  application?: Application;
}

export async function runStdioServer(
  options: StdioTransportOptions = {},
): Promise<void> {
  const application = options.application ?? createApplication();
  const server = application.createMcpServer();
  const transport = new StdioServerTransport();
  installShutdown(async () => {
    await Promise.allSettled([server.close(), application.close()]);
  });

  await server.connect(transport);
}

async function main(): Promise<void> {
  try {
    await runStdioServer();
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

function installShutdown(shutdown: () => Promise<void>): {
  dispose(): void;
} {
  let closed = false;

  const handler = (signal: NodeJS.Signals) => {
    if (closed) {
      return;
    }

    closed = true;
    void shutdown().finally(() => {
      process.exit(signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1);
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
