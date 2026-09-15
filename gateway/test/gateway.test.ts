import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MAX_BODY_BYTES } from '@tn-mcps/config';
import { type RunningMcpBackend, startMcpBackend } from '@tn-mcps/mcp-common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RunningGateway, type StartGatewayOptions, startGateway } from '../src/app.js';

const developmentCredential = ['gateway', 'integration', 'credential'].join('-');

interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function environment(
  tokenFile: string,
  overrides: Record<string, string> = {},
): NonNullable<StartGatewayOptions['env']> {
  return {
    NODE_ENV: 'development',
    TN_AUTH_MODE: 'dev',
    TN_DEV_TOKEN_FILE: tokenFile,
    TN_BIND_HOST: '127.0.0.1',
    TN_LOG_LEVEL: 'silent',
    ...overrides,
  };
}

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

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function request(
  url: URL,
  options: {
    method?: string;
    headers?: Record<string, string>;
    chunks?: readonly (string | Buffer)[];
  } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    outgoing.on('error', reject);
    for (const chunk of options.chunks ?? []) {
      outgoing.write(chunk);
    }
    outgoing.end();
  });
}

function authenticatedHeaders(body = '{}'): Record<string, string> {
  return {
    authorization: `Bearer ${developmentCredential}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'content-length': Buffer.byteLength(body).toString(),
  };
}

async function connectGatewayClient(gateway: RunningGateway, modern: boolean): Promise<Client> {
  const client = new Client(
    { name: 'gateway-e2e-client', version: '1.0.0' },
    modern ? { versionNegotiation: { mode: 'auto' } } : {},
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/cloudflare/mcp', gateway.url), {
      requestInit: { headers: { authorization: `Bearer ${developmentCredential}` } },
    }),
  );
  return client;
}

describe('gateway MCP proxy over real HTTP', () => {
  let directory: string;
  let tokenFile: string;
  let backend: RunningMcpBackend;
  let gateway: RunningGateway;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tn-gateway-mcp-'));
    tokenFile = join(directory, 'dev-token');
    await writeFile(tokenFile, developmentCredential, { mode: 0o600 });
    backend = await startMcpBackend({
      processName: 'cloudflare',
      version: 'gateway-test-backend',
      env: environment(tokenFile),
      listenPortOverride: 0,
    });
    gateway = await startGateway({
      env: environment(tokenFile),
      listenPortOverride: 0,
      routeTargets: { cloudflare: backend.url },
    });
  });

  afterAll(async () => {
    await gateway.close();
    await backend.close();
    await rm(directory, { recursive: true });
  });

  it('auto-negotiates modern MCP and calls tn_status through the gateway', async () => {
    const client = await connectGatewayClient(gateway, true);
    try {
      expect(client.getProtocolEra()).toBe('modern');
      const listed = await client.listTools();
      expect(listed.tools.map(({ name }) => name)).toEqual(['tn_status']);
      const result = await client.callTool({ name: 'tn_status', arguments: {} });
      expect(result.structuredContent).toMatchObject({
        server: 'cloudflare',
        version: 'gateway-test-backend',
        era: 'modern',
      });
    } finally {
      await client.close();
    }
  });

  it('uses legacy MCP by default and calls tn_status through the gateway', async () => {
    const client = await connectGatewayClient(gateway, false);
    try {
      expect(client.getProtocolEra()).toBe('legacy');
      const result = await client.callTool({ name: 'tn_status', arguments: {} });
      expect(result.structuredContent).toMatchObject({
        server: 'cloudflare',
        version: 'gateway-test-backend',
        era: 'legacy',
      });
    } finally {
      await client.close();
    }
  });
});

describe('gateway request pipeline and header boundary', () => {
  let directory: string;
  let tokenFile: string;
  let echoServer: Server;
  let echoUrl: string;
  let gateway: RunningGateway;
  const receivedHeaders: IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tn-gateway-echo-'));
    tokenFile = join(directory, 'dev-token');
    await writeFile(tokenFile, developmentCredential, { mode: 0o600 });
    echoServer = createServer((incoming, response) => {
      receivedHeaders.push({ ...incoming.headers });
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'set-cookie': 'must-not-pass=1',
        'x-private-upstream': 'must-not-pass',
      });
      response.end('{"proxied":true}');
    });
    echoUrl = await listen(echoServer);
    gateway = await startGateway({
      env: environment(tokenFile),
      listenPortOverride: 0,
      routeTargets: { cloudflare: echoUrl },
    });
  });

  afterAll(async () => {
    await gateway.close();
    await closeServer(echoServer);
    await rm(directory, { recursive: true });
  });

  it('forwards only allowed headers and replaces client assertions', async () => {
    const body = '{}';
    const response = await request(new URL('/cloudflare/mcp', gateway.url), {
      method: 'POST',
      headers: {
        ...authenticatedHeaders(body),
        cookie: 'private-cookie',
        origin: gateway.url,
        'x-request-id': 'gateway.header-test',
        'x-tn-dev-assertion': 'client-supplied-dev-value',
        'cf-access-jwt-assertion': 'client-supplied-access-value',
        'mcp-method': 'tools/call',
        'mcp-param-example': 'allowed',
        'x-private-client': 'must-not-pass',
      },
      chunks: [body],
    });

    expect(response.status).toBe(200);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['x-private-upstream']).toBeUndefined();
    const forwarded = receivedHeaders.at(-1);
    expect(forwarded).toMatchObject({
      host: new URL(echoUrl).host,
      'x-request-id': 'gateway.header-test',
      'x-tn-dev-assertion': developmentCredential,
      'mcp-method': 'tools/call',
      'mcp-param-example': 'allowed',
    });
    expect(forwarded?.authorization).toBeUndefined();
    expect(forwarded?.cookie).toBeUndefined();
    expect(forwarded?.origin).toBeUndefined();
    expect(forwarded?.['cf-access-jwt-assertion']).toBeUndefined();
    expect(forwarded?.['x-private-client']).toBeUndefined();
  });

  it('does not contact the backend when authentication fails', async () => {
    const hitsBefore = receivedHeaders.length;
    const response = await request(new URL('/cloudflare/mcp', gateway.url), {
      method: 'POST',
      headers: {
        ...authenticatedHeaders('{}'),
        authorization: 'Bearer wrong',
      },
      chunks: ['{}'],
    });
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'unauthorized' });
    expect(receivedHeaders).toHaveLength(hitsBefore);
  });

  it('rejects hostile Host and Origin values before proxying', async () => {
    const hitsBefore = receivedHeaders.length;
    const hostileHost = await request(new URL('/cloudflare/mcp', gateway.url), {
      method: 'POST',
      headers: { ...authenticatedHeaders('{}'), host: 'evil.example' },
      chunks: ['{}'],
    });
    const hostileOrigin = await request(new URL('/cloudflare/mcp', gateway.url), {
      method: 'POST',
      headers: { ...authenticatedHeaders('{}'), origin: 'https://evil.example' },
      chunks: ['{}'],
    });
    expect(hostileHost.status).toBe(403);
    expect(hostileOrigin.status).toBe(403);
    expect(receivedHeaders).toHaveLength(hitsBefore);
  });

  it('allows an absent Origin for a non-browser client', async () => {
    const response = await request(new URL('/cloudflare/mcp', gateway.url), {
      method: 'POST',
      headers: authenticatedHeaders('{}'),
      chunks: ['{}'],
    });
    expect(response.status).toBe(200);
  });

  it.each(['GET', 'DELETE'])(
    'returns 405 for %s on an MCP route without proxying',
    async (method) => {
      const hitsBefore = receivedHeaders.length;
      const response = await request(new URL('/cloudflare/mcp', gateway.url), { method });
      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe('POST');
      expect(receivedHeaders).toHaveLength(hitsBefore);
    },
  );

  it('returns 404 for an unknown route', async () => {
    const response = await request(new URL('/nope', gateway.url));
    expect(response.status).toBe(404);
  });

  it('rejects a body above 1 MiB before proxying when its length is declared', async () => {
    const hitsBefore = receivedHeaders.length;
    const body = Buffer.alloc(MAX_BODY_BYTES + 1, 97);
    const response = await request(new URL('/cloudflare/mcp', gateway.url), {
      method: 'POST',
      headers: authenticatedHeaders(body.toString()),
      chunks: [body],
    });
    expect(response.status).toBe(413);
    expect(receivedHeaders).toHaveLength(hitsBefore);
  });

  it('counts and rejects a chunked body above 1 MiB while streaming', async () => {
    const response = await request(new URL('/cloudflare/mcp', gateway.url), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${developmentCredential}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      chunks: [Buffer.alloc(MAX_BODY_BYTES, 97), Buffer.from('x')],
    });
    expect(response.status).toBe(413);
  });

  it('echoes a valid request ID and replaces an invalid one', async () => {
    const valid = await request(new URL('/cloudflare/mcp', gateway.url), {
      method: 'POST',
      headers: { ...authenticatedHeaders('{}'), 'x-request-id': 'valid.request-id' },
      chunks: ['{}'],
    });
    const invalid = await request(new URL('/cloudflare/mcp', gateway.url), {
      method: 'POST',
      headers: { ...authenticatedHeaders('{}'), 'x-request-id': 'contains space' },
      chunks: ['{}'],
    });
    expect(valid.headers['x-request-id']).toBe('valid.request-id');
    expect(invalid.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(invalid.headers['x-request-id']).not.toBe('contains space');
  });

  it('serves health without authentication', async () => {
    const response = await request(new URL('/healthz', gateway.url));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'ok', version: '0.0.0' });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('gateway limits and upstream failure mapping', () => {
  let directory: string;
  let tokenFile: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tn-gateway-failures-'));
    tokenFile = join(directory, 'dev-token');
    await writeFile(tokenFile, developmentCredential, { mode: 0o600 });
  });

  afterAll(async () => {
    await rm(directory, { recursive: true });
  });

  it('rate-limits by principal and includes Retry-After', async () => {
    const backend = createServer((_incoming, response) => response.end('{}'));
    const backendUrl = await listen(backend);
    const gateway = await startGateway({
      env: environment(tokenFile, { TN_RATE_LIMIT_PER_MINUTE: '1' }),
      listenPortOverride: 0,
      routeTargets: { cloudflare: backendUrl },
    });
    try {
      const first = await request(new URL('/cloudflare/mcp', gateway.url), {
        method: 'POST',
        headers: authenticatedHeaders('{}'),
        chunks: ['{}'],
      });
      const second = await request(new URL('/cloudflare/mcp', gateway.url), {
        method: 'POST',
        headers: authenticatedHeaders('{}'),
        chunks: ['{}'],
      });
      expect(first.status).toBe(200);
      expect(second.status).toBe(429);
      expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await gateway.close();
      await closeServer(backend);
    }
  });

  it('maps a refused backend connection to 503 without internal details', async () => {
    const portHolder = createServer();
    const unavailableUrl = await listen(portHolder);
    await closeServer(portHolder);
    const gateway = await startGateway({
      env: environment(tokenFile),
      listenPortOverride: 0,
      routeTargets: { cloudflare: unavailableUrl },
    });
    try {
      const response = await request(new URL('/cloudflare/mcp', gateway.url), {
        method: 'POST',
        headers: authenticatedHeaders('{}'),
        chunks: ['{}'],
      });
      expect(response.status).toBe(503);
      expect(JSON.parse(response.body)).toEqual({ error: 'backend unavailable' });
      expect(response.body).not.toContain(new URL(unavailableUrl).host);
    } finally {
      await gateway.close();
    }
  });

  it('maps a hanging backend to 504', async () => {
    const backend = createServer(() => undefined);
    const backendUrl = await listen(backend);
    const gateway = await startGateway({
      env: environment(tokenFile),
      listenPortOverride: 0,
      routeTargets: { cloudflare: backendUrl },
      upstreamTimeoutMs: 200,
    });
    try {
      const response = await request(new URL('/cloudflare/mcp', gateway.url), {
        method: 'POST',
        headers: authenticatedHeaders('{}'),
        chunks: ['{}'],
      });
      expect(response.status).toBe(504);
      expect(JSON.parse(response.body)).toEqual({ error: 'upstream timeout' });
    } finally {
      await gateway.close();
      await closeServer(backend);
    }
  });
});

describe('gateway streaming and cancellation', () => {
  let directory: string;
  let tokenFile: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tn-gateway-streaming-'));
    tokenFile = join(directory, 'dev-token');
    await writeFile(tokenFile, developmentCredential, { mode: 0o600 });
  });

  afterAll(async () => {
    await rm(directory, { recursive: true });
  });

  it('logs a redacted request ID when the request pipeline throws', async () => {
    const errors: Array<{ bindings: Record<string, unknown>; message: string }> = [];
    const gateway = await startGateway(
      {
        env: environment(tokenFile),
        listenPortOverride: 0,
      },
      {
        authenticator: {
          async authenticate() {
            throw new Error('Authorization: Bearer must-not-reach-the-log');
          },
        },
        logger: {
          info() {},
          error(bindings, message) {
            errors.push({ bindings, message });
          },
        },
      },
    );

    try {
      const body = '{}';
      const response = await request(new URL('/cloudflare/mcp', gateway.url), {
        method: 'POST',
        headers: {
          ...authenticatedHeaders(body),
          'x-request-id': 'pipeline.failure-test',
        },
        chunks: [body],
      });

      expect(response.status).toBe(500);
      expect(JSON.parse(response.body)).toEqual({ error: 'internal server error' });
      expect(errors).toEqual([
        {
          bindings: {
            error: {
              name: 'Error',
              message: 'Authorization: Bearer [REDACTED]',
            },
            requestId: 'pipeline.failure-test',
          },
          message: 'unexpected request pipeline error',
        },
      ]);
    } finally {
      await gateway.close();
    }
  });

  it('delivers the first SSE event before the backend sends the second', async () => {
    let secondSentAt = Number.POSITIVE_INFINITY;
    const backend = createServer((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
      setTimeout(() => {
        secondSentAt = performance.now();
        response.end('data: second\n\n');
      }, 100);
    });
    const backendUrl = await listen(backend);
    const gateway = await startGateway({
      env: environment(tokenFile),
      listenPortOverride: 0,
      routeTargets: { cloudflare: backendUrl },
    });

    try {
      const observation = await new Promise<{
        body: string;
        firstReceivedAt: number;
        bufferingHeader: string | undefined;
      }>((resolve, reject) => {
        const outgoing = httpRequest(
          new URL('/cloudflare/mcp', gateway.url),
          {
            method: 'POST',
            headers: authenticatedHeaders('{}'),
            agent: false,
          },
          (response) => {
            let body = '';
            let firstReceivedAt = Number.POSITIVE_INFINITY;
            response.on('data', (chunk: Buffer) => {
              if (body.length === 0) {
                firstReceivedAt = performance.now();
              }
              body += chunk.toString('utf8');
            });
            response.on('end', () =>
              resolve({
                body,
                firstReceivedAt,
                bufferingHeader:
                  typeof response.headers['x-accel-buffering'] === 'string'
                    ? response.headers['x-accel-buffering']
                    : undefined,
              }),
            );
          },
        );
        outgoing.on('error', reject);
        outgoing.end('{}');
      });

      expect(observation.firstReceivedAt).toBeLessThan(secondSentAt);
      expect(observation.body).toBe('data: first\n\ndata: second\n\n');
      expect(observation.bufferingHeader).toBe('no');
    } finally {
      await gateway.close();
      await closeServer(backend);
    }
  });

  it('aborts the upstream request when the client disconnects', async () => {
    let markBackendReached: (() => void) | undefined;
    let markBackendClosed: (() => void) | undefined;
    const backendReached = new Promise<void>((resolve) => {
      markBackendReached = resolve;
    });
    const backendClosed = new Promise<void>((resolve) => {
      markBackendClosed = resolve;
    });
    const backend = createServer((incoming) => {
      markBackendReached?.();
      incoming.once('close', () => markBackendClosed?.());
    });
    const backendUrl = await listen(backend);
    const gateway = await startGateway({
      env: environment(tokenFile),
      listenPortOverride: 0,
      routeTargets: { cloudflare: backendUrl },
    });

    try {
      const outgoing = httpRequest(new URL('/cloudflare/mcp', gateway.url), {
        method: 'POST',
        headers: authenticatedHeaders('{}'),
        agent: false,
      });
      outgoing.on('error', () => undefined);
      outgoing.end('{}');
      await backendReached;
      outgoing.destroy();
      await expect(backendClosed).resolves.toBeUndefined();
    } finally {
      await gateway.close();
      await closeServer(backend);
    }
  });
});
