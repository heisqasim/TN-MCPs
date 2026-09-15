import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { DEV_ASSERTION_HEADER } from '@tn-mcps/auth';
import { MAX_BODY_BYTES } from '@tn-mcps/config';
import { createLogger } from '@tn-mcps/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createTelosMcpServer,
  defineTool,
  type RunningMcpBackend,
  startMcpBackend,
  type ToolDefinition,
} from '../src/index.js';

const version = '2.0.0-test';
const developmentCredential = ['local', 'integration', 'credential'].join('-');
const logger = createLogger({ name: 'mcp-common-test', level: 'silent' });
const statusDescription =
  "Report this Telos MCP server's name, version, MCP specification revision, and negotiated protocol era. Read-only; takes no input.";

interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function environment(tokenFile: string): Record<string, string> {
  return {
    NODE_ENV: 'development',
    TN_AUTH_MODE: 'dev',
    TN_DEV_TOKEN_FILE: tokenFile,
    TN_BIND_HOST: '127.0.0.1',
    TN_LOG_LEVEL: 'silent',
  };
}

async function makeTokenFile(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'tn-mcp-common-'));
  const path = join(directory, 'dev-token');
  await writeFile(path, developmentCredential, { mode: 0o600 });
  return { directory, path };
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

function requestWithoutFinishingBody(url: URL): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const outgoing = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': String(900 * 1_024),
        },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          settled = true;
          clearTimeout(timeout);
          outgoing.destroy();
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    const timeout = setTimeout(() => {
      outgoing.destroy();
      reject(new Error('server waited for the unauthenticated request body'));
    }, 1_000);
    outgoing.on('error', (error) => {
      if (!settled) {
        clearTimeout(timeout);
        reject(error);
      }
    });
    outgoing.write('{');
  });
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
  return `http://127.0.0.1:${address.port}/mcp`;
}

function mcpHeaders(assertion = developmentCredential): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    [DEV_ASSERTION_HEADER]: assertion,
  };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const text = result.content.find((item) => item.type === 'text');
  return text?.type === 'text' ? text.text : '';
}

async function connectClient(backend: RunningMcpBackend, mode?: 'auto'): Promise<Client> {
  const client = new Client(
    { name: 'integration-client', version: '1.0.0' },
    mode === undefined ? {} : { versionNegotiation: { mode } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(backend.url), {
    requestInit: { headers: { [DEV_ASSERTION_HEADER]: developmentCredential } },
  });
  await client.connect(transport);
  return client;
}

describe('MCP backend over real HTTP', () => {
  let tokenDirectory: string;
  let tokenFile: string;
  let backend: RunningMcpBackend;

  beforeAll(async () => {
    const token = await makeTokenFile();
    tokenDirectory = token.directory;
    tokenFile = token.path;
    backend = await startMcpBackend({
      processName: 'cloudflare',
      version,
      env: environment(tokenFile),
      listenPortOverride: 0,
      logger,
    });
  });

  afterAll(async () => {
    await backend.close();
    await rm(tokenDirectory, { recursive: true });
  });

  it('auto-negotiates the modern era and calls tn_status', async () => {
    const client = await connectClient(backend, 'auto');
    try {
      expect(client.getProtocolEra()).toBe('modern');
      const result = await client.callTool({ name: 'tn_status', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        server: 'cloudflare',
        version,
        specRevision: '2026-07-28',
        era: 'modern',
      });
      expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
    } finally {
      await client.close();
    }
  });

  it('uses the legacy era by default and calls tn_status', async () => {
    const client = await connectClient(backend);
    try {
      expect(client.getProtocolEra()).toBe('legacy');
      const result = await client.callTool({ name: 'tn_status', arguments: {} });
      expect(result.structuredContent).toEqual({
        server: 'cloudflare',
        version,
        specRevision: '2026-07-28',
        era: 'legacy',
      });
    } finally {
      await client.close();
    }
  });

  it('lists exactly tn_status on the default server', async () => {
    const client = await connectClient(backend);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map(({ name }) => name)).toEqual(['tn_status']);
      expect(listed.tools[0]?.description).toBe(statusDescription);
    } finally {
      await client.close();
    }
  });

  it.each([
    ['missing assertion', {}],
    ['wrong assertion', { [DEV_ASSERTION_HEADER]: 'wrong' }],
    ['bearer header only', { authorization: `Bearer ${developmentCredential}` }],
  ])('returns 401 for %s', async (_case, authenticationHeaders) => {
    const response = await request(new URL(backend.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...authenticationHeaders,
      },
      chunks: ['{}'],
    });

    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(JSON.parse(response.body)).toEqual({ error: 'unauthorized' });
  });

  it('returns 401 without waiting for an unauthenticated large body', async () => {
    const response = await requestWithoutFinishingBody(new URL(backend.url));
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'unauthorized' });
  });

  it('rejects a hostile Host header', async () => {
    const response = await request(new URL(backend.url), {
      method: 'POST',
      headers: { ...mcpHeaders(), host: 'evil.example' },
      chunks: ['{}'],
    });
    expect(response.status).toBe(403);
  });

  it('rejects every Origin header', async () => {
    const response = await request(new URL(backend.url), {
      method: 'POST',
      headers: { ...mcpHeaders(), origin: 'http://127.0.0.1' },
      chunks: ['{}'],
    });
    expect(response.status).toBe(403);
  });

  it.each(['GET', 'DELETE'])('returns 405 for %s /mcp', async (method) => {
    const response = await request(new URL(backend.url), { method });
    expect(response.status).toBe(405);
  });

  it('rejects a chunked body above 1 MiB while streaming', async () => {
    const response = await request(new URL(backend.url), {
      method: 'POST',
      headers: mcpHeaders(),
      chunks: [Buffer.alloc(MAX_BODY_BYTES, 97), Buffer.from('x')],
    });
    expect(response.status).toBe(413);
  });

  it('returns the JSON-RPC parse error for malformed JSON', async () => {
    const response = await request(new URL(backend.url), {
      method: 'POST',
      headers: mcpHeaders(),
      chunks: ['{'],
    });
    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toBe('application/json');
    expect(JSON.parse(response.body)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  });

  it('returns 404 for unknown routes', async () => {
    const response = await request(new URL('/nope', backend.url));
    expect(response.status).toBe(404);
  });

  it('returns the public health shape and echoes a valid request ID', async () => {
    const response = await request(new URL('/healthz', backend.url), {
      headers: { 'x-request-id': 'integration.request-1' },
    });
    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe('integration.request-1');
    expect(JSON.parse(response.body)).toEqual({
      status: 'ok',
      server: 'cloudflare',
      version,
    });
  });
});

describe('policy wrapper over the SDK server', () => {
  let tokenDirectory: string;
  let backend: RunningMcpBackend;
  let client: Client;
  const logLines: string[] = [];
  const assembledCredentialShape = ['github', '_pat_', 'X'.repeat(22)].join('');
  const policyRequestId = 'policy-test-request';
  const policyLogger = createLogger({
    name: 'policy-wrapper-test',
    level: 'info',
    destination: new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(chunk.toString());
        callback();
      },
    }),
  });

  const common = {
    description: 'Exercise one policy-wrapper behavior.',
    provider: 'test',
    input: z.object({}),
  } as const;

  const tools: ToolDefinition[] = [
    defineTool({
      ...common,
      name: 'test_write',
      risk: 'R1',
      scopes: ['tn:read'],
      approval: 'policy',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async handler() {
        return { content: [{ type: 'text', text: 'must not run' }] };
      },
    }),
    defineTool({
      ...common,
      name: 'test_missing_scope',
      risk: 'R0',
      scopes: ['github:write'],
      approval: 'never',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async handler() {
        return { content: [{ type: 'text', text: 'must not run' }] };
      },
    }),
    defineTool({
      ...common,
      name: 'test_large_result',
      risk: 'R0',
      scopes: ['tn:read'],
      approval: 'never',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async handler() {
        return { content: [{ type: 'text', text: 'L'.repeat(50_000) }] };
      },
    }),
    defineTool({
      ...common,
      name: 'test_throw',
      risk: 'R0',
      scopes: ['tn:read'],
      approval: 'never',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async handler() {
        throw new Error(`provider rejected ${assembledCredentialShape}`);
      },
    }),
    defineTool({
      ...common,
      name: 'test_context_boundary',
      risk: 'R0',
      scopes: ['tn:read'],
      approval: 'never',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async handler(_args, context) {
        const keys = Object.keys(context).sort();
        const forbidden = ['request', 'headers', 'cookies', 'credentials', 'authInfo', 'token'];
        return {
          content: [{ type: 'text', text: JSON.stringify({ keys, forbidden }) }],
          structuredContent: {
            keys,
            forbiddenPresent: forbidden.some((key) => Object.hasOwn(context, key)),
            credentialPresent: JSON.stringify({ keys, principal: context.principal }).includes(
              developmentCredential,
            ),
          },
        };
      },
    }),
  ];

  beforeAll(async () => {
    const token = await makeTokenFile();
    tokenDirectory = token.directory;
    backend = await startMcpBackend({
      processName: 'cloudflare',
      version,
      tools,
      env: environment(token.path),
      listenPortOverride: 0,
      logger: policyLogger,
    });
    client = new Client({ name: 'policy-client', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(backend.url), {
        requestInit: {
          headers: {
            [DEV_ASSERTION_HEADER]: developmentCredential,
            'x-request-id': policyRequestId,
          },
        },
      }),
    );
  });

  afterAll(async () => {
    await client.close();
    await backend.close();
    await rm(tokenDirectory, { recursive: true });
  });

  it('marks R1 tools interactive and refuses them until Phase 3', async () => {
    const listed = await client.listTools();
    const tool = listed.tools.find(({ name }) => name === 'test_write');
    expect(tool?._meta).toMatchObject({ 'anthropic/requiresUserInteraction': true });

    const result = await client.callTool({ name: 'test_write', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('approval framework not available until Phase 3; refused');
  });

  it('refuses missing scopes and names all missing scopes', async () => {
    const result = await client.callTool({ name: 'test_missing_scope', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('github:write');
  });

  it('replaces an oversized result with the cap error', async () => {
    const result = await client.callTool({ name: 'test_large_result', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('result exceeded the 48 KiB cap');
  });

  it('redacts token-shaped text from thrown handler errors', async () => {
    const result = await client.callTool({ name: 'test_throw', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('provider rejected [REDACTED]');
    expect(textOf(result)).not.toContain(assembledCredentialShape);
    expect(logLines.join('')).toContain(policyRequestId);
    expect(logLines.join('')).not.toContain(assembledCredentialShape);
  });

  it('exposes no request, header, credential, AuthInfo, or token in ToolContext', async () => {
    const result = await client.callTool({ name: 'test_context_boundary', arguments: {} });
    expect(result.structuredContent).toEqual({
      keys: ['logger', 'principal', 'requestId', 'server', 'signal'],
      forbiddenPresent: false,
      credentialPresent: false,
    });
    expect(JSON.stringify(result)).not.toContain(developmentCredential);
  });
});

describe('principal kind validation through the SDK', () => {
  it.each([
    ['absent', undefined],
    ['unrecognized', 'robot'],
  ] as const)('refuses an %s principal kind', async (_case, principalKind) => {
    const mcp = createTelosMcpServer({ name: 'kind-test', version, logger });
    const authInfo: AuthInfo = {
      token: 'verified-principal-placeholder',
      clientId: 'kind-test-client',
      scopes: ['tn:read'],
      ...(principalKind === undefined ? {} : { extra: { principalKind } }),
    };
    const server = createServer((request, response) => {
      const authenticatedRequest = request as IncomingMessage & {
        auth: AuthInfo;
        method: string;
        url: string;
      };
      authenticatedRequest.auth = authInfo;
      void mcp.nodeHandler(authenticatedRequest, response);
    });
    const url = await listen(server);
    const client = new Client({ name: 'kind-test-client', version: '1.0.0' });

    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      const result = await client.callTool({ name: 'tn_status', arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('verified principal unavailable; refused');
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      await mcp.close();
    }
  });
});
