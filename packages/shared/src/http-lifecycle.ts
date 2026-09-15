import type { Server } from 'node:http';

import { redact } from './redact.js';

export interface HttpLifecycleOptions {
  drainMs: number;
}

export interface HttpLifecycle {
  shutdown(): Promise<void>;
  installSignalHandlers(): void;
}

export function createHttpLifecycle(server: Server, options: HttpLifecycleOptions): HttpLifecycle {
  if (!Number.isFinite(options.drainMs) || options.drainMs < 0) {
    throw new RangeError('drainMs must be a non-negative finite number');
  }

  let shutdownPromise: Promise<void> | undefined;

  function shutdown(): Promise<void> {
    if (shutdownPromise !== undefined) {
      return shutdownPromise;
    }

    shutdownPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(forceCloseTimer);
        if (
          error !== undefined &&
          (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
        ) {
          reject(error);
          return;
        }
        resolve();
      };

      const forceCloseTimer = setTimeout(() => {
        server.closeAllConnections();
        finish();
      }, options.drainMs);
      forceCloseTimer.unref();

      server.close((error) => finish(error));
    });

    return shutdownPromise;
  }

  function installSignalHandlers(): void {
    const handleSignal = () => {
      void shutdown().catch((error: unknown) => {
        console.error(JSON.stringify({ error: redact(error) }));
        process.exitCode = 1;
      });
    };
    process.once('SIGTERM', handleSignal);
    process.once('SIGINT', handleSignal);
  }

  return { shutdown, installSignalHandlers };
}
