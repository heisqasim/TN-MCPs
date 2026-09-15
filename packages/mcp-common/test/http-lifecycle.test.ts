import { createServer, get, type Server } from 'node:http';

import { createHttpLifecycle } from '@tn-mcps/shared';
import { afterEach, describe, expect, it } from 'vitest';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind a TCP port');
  }
  return `http://127.0.0.1:${address.port}`;
}

function fetchWithoutPooling(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = get(url, { agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    request.on('error', reject);
  });
}

describe('createHttpLifecycle', () => {
  const servers: Server[] = [];

  afterEach(() => {
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
    servers.length = 0;
  });

  it('drains an in-flight request while refusing new connections', async () => {
    let releaseRequest: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const server = createServer((_request, response) => {
      markStarted?.();
      void release.then(() => response.end('complete'));
    });
    servers.push(server);
    const url = await listen(server);
    const inFlight = fetchWithoutPooling(url);
    await started;

    const lifecycle = createHttpLifecycle(server, { drainMs: 1_000 });
    const shutdown = lifecycle.shutdown();
    await expect(fetchWithoutPooling(url)).rejects.toBeDefined();
    releaseRequest?.();

    await expect(inFlight).resolves.toBe('complete');
    await expect(shutdown).resolves.toBeUndefined();
  });

  it('forces active connections closed after the drain timeout', async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const server = createServer(() => markStarted?.());
    servers.push(server);
    const url = await listen(server);
    const inFlight = fetchWithoutPooling(url);
    await started;

    const lifecycle = createHttpLifecycle(server, { drainMs: 25 });
    const before = performance.now();
    await lifecycle.shutdown();

    expect(performance.now() - before).toBeGreaterThanOrEqual(15);
    await expect(inFlight).rejects.toBeDefined();
  });
});
