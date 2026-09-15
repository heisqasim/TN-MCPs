import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import { type AddressInfo, connect as connectTcp } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { EDGE_HEADERS, MAX_BODY_BYTES } from '@tn-mcps/config';
import { type RunningMcpBackend, startMcpBackend } from '@tn-mcps/mcp-common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addIdentityAssertion,
  type RunningGateway,
  type StartGatewayOptions,
  startGateway,
} from '../src/app.js';

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
      routeTargets: { cloudflare: `${echoUrl}/mcp` },
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
        'cf-worker': 'client-supplied-worker-value',
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
      'x-request-id': expect.stringMatching(/^[0-9a-f-]{36}$/),
      'x-tn-dev-assertion': developmentCredential,
      'mcp-method': 'tools/call',
      'mcp-param-example': 'allowed',
    });
    expect(forwarded?.['x-request-id']).not.toBe('gateway.header-test');
    expect(forwarded?.authorization).toBeUndefined();
    expect(forwarded?.cookie).toBeUndefined();
    expect(forwarded?.origin).toBeUndefined();
    expect(forwarded?.['cf-worker']).toBeUndefined();
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
    expect(hostileHost.headers.connection).toBe('close');
    expect(hostileOrigin.status).toBe(403);
    expect(receivedHeaders).toHaveLength(hitsBefore);
  });

  it.each(EDGE_HEADERS)(
    'refuses %s at the gateway in dev auth mode before proxying',
    async (header) => {
      const hitsBefore = receivedHeaders.length;
      const response = await request(new URL('/cloudflare/mcp', gateway.url), {
        method: 'POST',
        headers: { ...authenticatedHeaders('{}'), [header]: 'edge-value' },
        chunks: ['{}'],
      });
      expect(response.status).toBe(403);
      expect(response.headers.connection).toBe('close');
      expect(receivedHeaders).toHaveLength(hitsBefore);
    },
  );

  it('warns (redacted) when edge headers are refused in dev mode', async () => {
    const warnings: Array<{ bindings: Record<string, unknown>; message: string }> = [];
    const warnedGateway = await startGateway(
      {
        env: environment(tokenFile),
        listenPortOverride: 0,
        routeTargets: { cloudflare: `${echoUrl}/mcp` },
      },
      {
        logger: {
          info() {},
          warn(bindings, message) {
            warnings.push({ bindings, message });
          },
          error() {},
        },
      },
    );
    try {
      const response = await request(new URL('/cloudflare/mcp', warnedGateway.url), {
        method: 'POST',
        headers: {
          ...authenticatedHeaders('{}'),
          'cf-connecting-ip': '203.0.113.9',
          'x-forwarded-for': '203.0.113.9',
        },
        chunks: ['{}'],
      });
      expect(response.status).toBe(403);
      expect(warnings).toEqual([
        {
          bindings: {
            edgeHeaders: ['cf-connecting-ip', 'x-forwarded-for'],
            requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          },
          message: 'edge headers rejected in dev auth mode',
        },
      ]);
    } finally {
      await warnedGateway.close();
    }
  });

  it('does not refuse edge headers in access mode, but never forwards the unverified assertion', async () => {
    const errors: Array<{ bindings: Record<string, unknown>; message: string }> = [];
    const accessGateway = await startGateway(
      {
        env: environment(tokenFile, { TN_AUTH_MODE: 'access' }),
        listenPortOverride: 0,
        routeTargets: { cloudflare: `${echoUrl}/mcp` },
      },
      {
        authenticator: {
          async authenticate() {
            return {
              ok: true,
              principal: { kind: 'service', id: 'access-test-principal', scopes: ['tn:read'] },
            };
          },
        },
        logger: {
          info() {},
          warn() {},
          error(bindings, message) {
            errors.push({ bindings, message });
          },
        },
      },
    );
    try {
      const response = await request(new URL('/cloudflare/mcp', accessGateway.url), {
        method: 'POST',
        headers: {
          ...authenticatedHeaders('{}'),
          origin: accessGateway.url,
          'cf-access-jwt-assertion': 'access-assertion-value',
          'cf-ray': 'edge-ray-value',
        },
        chunks: ['{}'],
      });
      // The dev-mode edge-header tripwire must not fire in access mode...
      expect(response.status).not.toBe(403);
      // ...but the unverified assertion must not be forwarded either; the guard
      // answers 500 and names the Phase 4 requirement in the redacted error log.
      expect(response.status).toBe(500);
      expect(JSON.parse(response.body)).toEqual({ error: 'internal server error' });
      expect(errors).toEqual([
        {
          bindings: {
            error: {
              name: 'Error',
              message: 'access-mode forwarding requires Phase 4 verification',
            },
            requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          },
          message: 'unexpected request pipeline error',
        },
      ]);
    } finally {
      await accessGateway.close();
    }
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

  it('always serves its own request ID and never adopts a client-supplied one', async () => {
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
    expect(valid.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(valid.headers['x-request-id']).not.toBe('valid.request-id');
    expect(invalid.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(invalid.headers['x-request-id']).not.toBe('contains space');
  });

  it('logs a syntactically valid client request ID without adopting it', async () => {
    const completions: Array<{ bindings: Record<string, unknown>; message: string }> = [];
    const loggedGateway = await startGateway(
      {
        env: environment(tokenFile),
        listenPortOverride: 0,
        routeTargets: { cloudflare: `${echoUrl}/mcp` },
      },
      {
        logger: {
          info(bindings, message) {
            completions.push({ bindings, message });
          },
          warn() {},
          error() {},
        },
      },
    );
    try {
      const response = await request(new URL('/cloudflare/mcp', loggedGateway.url), {
        method: 'POST',
        headers: { ...authenticatedHeaders('{}'), 'x-request-id': 'valid.request-id' },
        chunks: ['{}'],
      });
      expect(response.status).toBe(200);
      expect(completions).toHaveLength(1);
      const bindings = completions[0]?.bindings;
      expect(bindings?.clientRequestId).toBe('valid.request-id');
      expect(bindings?.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(bindings?.requestId).not.toBe('valid.request-id');
    } finally {
      await loggedGateway.close();
    }
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
      routeTargets: { cloudflare: `${backendUrl}/mcp` },
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
      routeTargets: { cloudflare: `${unavailableUrl}/mcp` },
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

  it('answers 413 for an over-limit chunked body even when the backend consumes it', async () => {
    const consuming = createServer((incoming, response) => {
      incoming.resume();
      incoming.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"consumed":true}');
      });
    });
    const backendUrl = await listen(consuming);
    const gateway = await startGateway({
      env: environment(tokenFile),
      listenPortOverride: 0,
      routeTargets: { cloudflare: `${backendUrl}/mcp` },
    });
    try {
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
      expect(JSON.parse(response.body)).toEqual({ error: 'request body too large' });
    } finally {
      await gateway.close();
      await closeServer(consuming);
    }
  });

  it('answers 413 for an over-limit chunked body even when the backend is down', async () => {
    const portHolder = createServer();
    const unavailableUrl = await listen(portHolder);
    await closeServer(portHolder);
    const gateway = await startGateway({
      env: environment(tokenFile),
      listenPortOverride: 0,
      routeTargets: { cloudflare: `${unavailableUrl}/mcp` },
    });
    try {
      const oversized = await request(new URL('/cloudflare/mcp', gateway.url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${developmentCredential}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        chunks: [Buffer.alloc(MAX_BODY_BYTES, 97), Buffer.from('x')],
      });
      expect(oversized.status).toBe(413);
      expect(JSON.parse(oversized.body)).toEqual({ error: 'request body too large' });

      // A body within the limit keeps the backend-failure mapping.
      const small = await request(new URL('/cloudflare/mcp', gateway.url), {
        method: 'POST',
        headers: authenticatedHeaders('{}'),
        chunks: ['{}'],
      });
      expect(small.status).toBe(503);
      expect(JSON.parse(small.body)).toEqual({ error: 'backend unavailable' });
    } finally {
      await gateway.close();
    }
  });

  it('forwards an early upstream response when the body stays within the limit', async () => {
    const early = createServer((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"early":true}');
    });
    const backendUrl = await listen(early);
    const gateway = await startGateway({
      env: environment(tokenFile),
      listenPortOverride: 0,
      routeTargets: { cloudflare: `${backendUrl}/mcp` },
    });
    try {
      const response = await request(new URL('/cloudflare/mcp', gateway.url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${developmentCredential}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        chunks: ['{}'],
      });
      expect(response.status).toBe(200);
      expect(response.body).toBe('{"early":true}');
    } finally {
      await gateway.close();
      await closeServer(early);
    }
  });

  it('maps a hanging backend to 504', async () => {
    const backend = createServer(() => undefined);
    const backendUrl = await listen(backend);
    const gateway = await startGateway({
      env: environment(tokenFile),
      listenPortOverride: 0,
      routeTargets: { cloudflare: `${backendUrl}/mcp` },
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
          warn() {},
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
            // The gateway owns request IDs; the client value is not adopted anywhere.
            requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
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
      routeTargets: { cloudflare: `${backendUrl}/mcp` },
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
      routeTargets: { cloudflare: `${backendUrl}/mcp` },
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

interface RawResult {
  response: {
    status: number;
    headers: Record<string, string>;
    body: string;
  };
  /** Milliseconds between a complete response and the socket closing; null when it never closed. */
  closed: Promise<number | null>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

/** Joins a raw chunked-response body back into its decoded payload. */
function decodeChunkedBody(raw: string): string {
  let decoded = '';
  let position = 0;
  while (position < raw.length) {
    const lineEnd = raw.indexOf('\r\n', position);
    if (lineEnd === -1) {
      break;
    }
    const size = Number.parseInt(raw.slice(position, lineEnd), 16);
    if (!Number.isFinite(size) || size === 0) {
      break;
    }
    decoded += raw.slice(lineEnd + 2, lineEnd + 2 + size);
    position = lineEnd + 2 + size + 2;
  }
  return decoded;
}

// Drives one HTTP/1.1 POST over a raw socket so tests can keep the request body open
// while the server responds, and can observe who closes the connection and when.
function rawPost(options: {
  port: number;
  path: string;
  headers?: Record<string, string>;
  body: string;
  finishBody?: boolean;
  /** Send the body with chunked framing instead of Content-Length. */
  chunked?: boolean;
  /** Additionally declare this Content-Length alongside chunked framing (smuggling probe). */
  conflictingContentLength?: string;
}): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    let raw = '';
    let respondedAt: number | undefined;
    let settled = false;
    let socket: ReturnType<typeof connectTcp> | undefined;

    const complete = (head: string, body: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(guard);
      const headers = Object.fromEntries(
        head
          .split('\r\n')
          .slice(1)
          .filter((line) => line.includes(':'))
          .map((line) => {
            const separator = line.indexOf(':');
            return [
              line.slice(0, separator).trim().toLowerCase(),
              line.slice(separator + 1).trim(),
            ] as const;
          }),
      );
      const timing = () => (respondedAt === undefined ? null : performance.now() - respondedAt);
      resolve({
        response: {
          status: Number(head.split(' ')[1] ?? 0),
          headers,
          body,
        },
        closed:
          socket === undefined || socket.destroyed || socket.readableEnded
            ? Promise.resolve(timing())
            : new Promise((resolveClose) => {
                socket?.once('close', () => resolveClose(timing()));
              }),
      });
    };

    const guard = setTimeout(() => {
      socket?.destroy();
      reject(new Error('raw request never received a complete response'));
    }, 3_000);
    guard.unref();

    socket = connectTcp({ host: '127.0.0.1', port: options.port }, () => {
      const bodyLine = options.chunked
        ? `${Buffer.byteLength(options.body).toString(16)}\r\n${options.body}\r\n0\r\n\r\n`
        : options.body;
      const headerLines = [
        `Host: ${options.headers?.host ?? '127.0.0.1'}`,
        ...Object.entries(options.headers ?? {})
          .filter(
            ([name]) => name.toLowerCase() !== 'host' && name.toLowerCase() !== 'content-length',
          )
          .map(([name, value]) => `${name}: ${value}`),
        ...(options.chunked ? ['Transfer-Encoding: chunked'] : []),
        ...(options.conflictingContentLength === undefined
          ? []
          : [`Content-Length: ${options.conflictingContentLength}`]),
        ...(options.chunked ? [] : [`Content-Length: ${Buffer.byteLength(options.body)}`]),
        'Connection: keep-alive',
      ];
      socket?.write(`POST ${options.path} HTTP/1.1\r\n${headerLines.join('\r\n')}\r\n\r\n`);
      socket?.write(bodyLine);
      if (options.finishBody !== false) {
        socket?.end();
      }
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      raw += chunk;
      if (respondedAt !== undefined) {
        return;
      }
      const separator = raw.indexOf('\r\n\r\n');
      if (separator === -1) {
        return;
      }
      const head = raw.slice(0, separator);
      const body = raw.slice(separator + 4);
      const contentLength = Number(
        Object.fromEntries(
          head
            .split('\r\n')
            .slice(1)
            .filter((line) => line.toLowerCase().startsWith('content-length:'))
            .map((line) => ['content-length', line.slice(line.indexOf(':') + 1).trim()] as const),
        ).contentLength ?? '0',
      );
      if (Buffer.byteLength(body) < contentLength) {
        return;
      }
      respondedAt = performance.now();
      complete(head, body);
    });
    socket.once('close', () => {
      if (settled) {
        return;
      }
      const separator = raw.indexOf('\r\n\r\n');
      respondedAt = performance.now();
      complete(raw.slice(0, separator), raw.slice(separator + 4));
    });
    socket.on('error', (error: Error) => {
      if (respondedAt === undefined && !settled) {
        clearTimeout(guard);
        reject(error);
      }
    });
  });
}

describe('gateway connections, overrides, and shutdown', () => {
  let directory: string;
  let tokenFile: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tn-gateway-hardening-'));
    tokenFile = join(directory, 'dev-token');
    await writeFile(tokenFile, developmentCredential, { mode: 0o600 });
  });

  afterAll(async () => {
    await rm(directory, { recursive: true });
  });

  it('closes the socket of a keep-alive request to an unknown route', async () => {
    const gateway = await startGateway({
      env: environment(tokenFile),
      listenPortOverride: 0,
    });
    try {
      const port = Number(new URL(gateway.url).port);
      const result = await rawPost({ port, path: '/nope', body: '{}', finishBody: false });

      expect(result.response.status).toBe(404);
      expect(result.response.headers.connection).toBe('close');
      const closedAfterMs = await result.closed;
      expect(closedAfterMs).not.toBeNull();
      expect(closedAfterMs).toBeLessThan(2_000);
    } finally {
      await gateway.close();
    }
  });

  it('disconnects a client that never finishes its headers after headersTimeout', async () => {
    const headersTimeoutMs = 250;
    const gateway = await startGateway({
      env: environment(tokenFile),
      listenPortOverride: 0,
      headersTimeoutMs,
    });
    try {
      const port = Number(new URL(gateway.url).port);
      const closedAt = new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('slow-headers socket never closed')),
          2_000,
        );
        timeout.unref();
        const socket = connectTcp({ host: '127.0.0.1', port }, () => {
          socket.write('POST /cloudflare/mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n');
        });
        // The client must consume the socket: a peer FIN hides behind unread
        // buffered data and would otherwise never surface as 'close'.
        socket.on('data', (_chunk: Buffer) => socket.resume());
        socket.once('error', (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        });
        socket.once('close', () => {
          clearTimeout(timeout);
          resolve(performance.now());
        });
      });

      const openedAt = performance.now();
      await expect(closedAt).resolves.toBeGreaterThan(openedAt);
    } finally {
      await gateway.close();
    }
  });

  it('removes signal handlers when the listen port is taken', async () => {
    const blocker = createServer();
    await listen(blocker);
    const port = (blocker.address() as AddressInfo).port;
    const sigtermBefore = process.listenerCount('SIGTERM');
    const sigintBefore = process.listenerCount('SIGINT');

    try {
      await expect(
        startGateway({
          env: environment(tokenFile),
          listenPortOverride: port,
          installSignalHandlers: true,
        }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });

      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
      expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    } finally {
      await closeServer(blocker);
    }
  });

  it('shuts down on SIGTERM without touching the process exit code', async () => {
    const sigtermBefore = process.listenerCount('SIGTERM');
    const sigintBefore = process.listenerCount('SIGINT');
    const gateway = await startGateway({
      env: environment(tokenFile),
      listenPortOverride: 0,
      installSignalHandlers: true,
    });
    try {
      process.emit('SIGTERM');
      await gateway.close();

      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
      expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    }
  });

  it('accepts an exact loopback /mcp route target', async () => {
    const echoBackend = createServer((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"proxied":true}');
    });
    const echoUrl = await listen(echoBackend);
    try {
      const gateway = await startGateway({
        env: environment(tokenFile),
        listenPortOverride: 0,
        routeTargets: { cloudflare: `${echoUrl}/mcp` },
      });
      await gateway.close();
    } finally {
      await closeServer(echoBackend);
    }
  });

  it.each([
    ['a URL without a path', 'http://127.0.0.1:8701'],
    ['a non-/mcp path', 'http://127.0.0.1:8701/other'],
    ['a URL with a query string', 'http://127.0.0.1:8701/mcp?x=1'],
    ['a URL with credentials', 'http://user:pass@127.0.0.1:8701/mcp'],
    ['a non-loopback host', 'http://192.0.2.9:8701/mcp'],
    ['a URL without a port', 'http://localhost/mcp'],
    ['an https URL', 'https://127.0.0.1:8701/mcp'],
  ])('refuses %s as a route target', async (_name, target) => {
    await expect(
      startGateway({
        env: environment(tokenFile),
        listenPortOverride: 0,
        routeTargets: { cloudflare: target },
      }),
    ).rejects.toThrow('http://<loopback>:<port>/mcp');
  });

  const productionEnvironment = {
    NODE_ENV: 'production',
    TN_AUTH_MODE: 'access',
    TN_LOG_LEVEL: 'silent',
  } as const;

  it.each([
    ['listenPortOverride', { listenPortOverride: 0 }],
    ['routeTargets', { routeTargets: { cloudflare: 'http://127.0.0.1:8701/mcp' } }],
    ['upstreamTimeoutMs', { upstreamTimeoutMs: 1_000 }],
    ['headersTimeoutMs', { headersTimeoutMs: 1_000 }],
  ] as const)('refuses the %s override in production', async (name, overrides) => {
    await expect(startGateway({ env: productionEnvironment, ...overrides })).rejects.toThrow(
      `${name} is test-only and cannot be used in production`,
    );
  });

  it('refuses the dependency seam in production', async () => {
    await expect(
      startGateway(
        { env: productionEnvironment },
        {
          authenticator: {
            async authenticate() {
              return { ok: true, principal: { kind: 'dev', id: 'dev', scopes: [] } };
            },
          },
        },
      ),
    ).rejects.toThrow('dependency overrides are test-only and cannot be used in production');
  });

  it('refuses the dependency seam logger alone in production', async () => {
    await expect(
      startGateway(
        { env: productionEnvironment },
        {
          logger: {
            info() {},
            warn() {},
            error() {},
          },
        },
      ),
    ).rejects.toThrow('dependency overrides are test-only and cannot be used in production');
  });
});

describe('gateway request framing', () => {
  let directory: string;
  let tokenFile: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tn-gateway-framing-'));
    tokenFile = join(directory, 'dev-token');
    await writeFile(tokenFile, developmentCredential, { mode: 0o600 });
  });

  afterAll(async () => {
    await rm(directory, { recursive: true });
  });

  async function startFramingGateway(backendUrl: string): Promise<RunningGateway> {
    return startGateway({
      env: environment(tokenFile),
      listenPortOverride: 0,
      routeTargets: { cloudflare: `${backendUrl}/mcp` },
    });
  }

  it.each([
    ['a chunked body', true],
    ['a declared-length body', false],
  ])(
    'forwards the streamed bytes of %s without the client Content-Length',
    async (_name, chunked) => {
      const requests: IncomingHttpHeaders[] = [];
      const echo = createServer((incoming, response) => {
        let body = '';
        incoming.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        incoming.on('end', () => {
          requests.push({ ...incoming.headers });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ received: body }));
        });
      });
      const echoUrl = await listen(echo);
      const gateway = await startFramingGateway(echoUrl);
      try {
        const response = await rawPost({
          port: Number(new URL(gateway.url).port),
          path: '/cloudflare/mcp',
          headers: authenticatedHeaders('{}'),
          body: '{}',
          chunked,
          // Keep the socket open: a client half-close aborts the response before the
          // backend has answered, which would make the forwarding itself unobservable.
          finishBody: false,
        });
        // Let any misframed trailing bytes produce a phantom request before asserting.
        await delay(100);

        expect(response.response.status).toBe(200);
        expect(JSON.parse(decodeChunkedBody(response.response.body))).toEqual({ received: '{}' });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.['content-length']).toBeUndefined();
        expect(requests[0]?.['transfer-encoding']).toBe('chunked');
      } finally {
        await gateway.close();
        await closeServer(echo);
      }
    },
  );

  it('refuses a request that mixes chunked framing with a conflicting Content-Length', async () => {
    const requests: IncomingHttpHeaders[] = [];
    const echo = createServer((incoming, response) => {
      requests.push({ ...incoming.headers });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"proxied":true}');
    });
    const echoUrl = await listen(echo);
    const gateway = await startFramingGateway(echoUrl);
    try {
      const response = await rawPost({
        port: Number(new URL(gateway.url).port),
        path: '/cloudflare/mcp',
        headers: authenticatedHeaders('{}'),
        body: '{}',
        chunked: true,
        conflictingContentLength: '5',
      });
      await delay(100);

      // Node's HTTP parser refuses the TE+CL pair, so nothing is proxied and no
      // phantom request can desync the backend.
      expect(response.response.status).toBe(400);
      expect(requests).toEqual([]);
    } finally {
      await gateway.close();
      await closeServer(echo);
    }
  });
});

describe('gateway upstream backpressure', () => {
  let directory: string;
  let tokenFile: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tn-gateway-backpressure-'));
    tokenFile = join(directory, 'dev-token');
    await writeFile(tokenFile, developmentCredential, { mode: 0o600 });
  });

  afterAll(async () => {
    await rm(directory, { recursive: true });
  });

  it('keeps at most one pending upstream drain listener while backpressuring', async () => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning);
    };
    process.on('warning', onWarning);

    // The backend stalls before reading, so the gateway's upstream socket
    // backpressures on every chunk beyond the socket highWaterMark.
    const slowEcho = createServer((incoming, response) => {
      incoming.pause();
      setTimeout(() => {
        let bytes = 0;
        incoming.resume();
        incoming.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength;
        });
        incoming.on('end', () => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ bytes }));
        });
      }, 150);
    });
    const echoUrl = await listen(slowEcho);
    const gateway = await startGateway({
      env: environment(tokenFile),
      listenPortOverride: 0,
      routeTargets: { cloudflare: `${echoUrl}/mcp` },
    });
    try {
      const chunks = Array.from({ length: 80 }, () => 'y'.repeat(4 * 1_024));
      const response = await request(new URL('/cloudflare/mcp', gateway.url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${developmentCredential}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        chunks,
      });
      await delay(50);

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ bytes: 80 * 4 * 1_024 });
      expect(warnings.filter((warning) => warning.name === 'MaxListenersExceededWarning')).toEqual(
        [],
      );
    } finally {
      process.off('warning', onWarning);
      await gateway.close();
      await closeServer(slowEcho);
    }
  });
});

describe('addIdentityAssertion access-mode guard', () => {
  it('refuses to forward a client access assertion in access mode', () => {
    expect(() =>
      addIdentityAssertion({}, { 'cf-access-jwt-assertion': 'unverified-value' }, 'access'),
    ).toThrow('access-mode forwarding requires Phase 4 verification');
  });

  it('keeps reporting a missing assertion as a plain refusal', () => {
    expect(addIdentityAssertion({}, {}, 'access')).toBe(false);
  });

  it('forwards the dev credential in dev mode', () => {
    const forwarded: Record<string, unknown> = {};
    expect(
      addIdentityAssertion(forwarded, { authorization: 'Bearer dev-credential-value' }, 'dev'),
    ).toBe(true);
    expect(forwarded['x-tn-dev-assertion']).toBe('dev-credential-value');
  });
});
