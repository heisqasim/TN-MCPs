import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLIENT_CAPABILITIES_META_KEY,
  Client,
  PROTOCOL_VERSION_META_KEY,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { SHUTDOWN_DRAIN_MS } from '@tn-mcps/config';
import {
  defineTool,
  type RunningMcpBackend,
  startMcpBackend,
  tnStatusTool,
} from '@tn-mcps/mcp-common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type RunningGateway, startGateway } from '../src/app.js';

vi.setConfig({ testTimeout: 10_000, hookTimeout: 15_000 });

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const gatewayEntry = join(repositoryRoot, 'gateway/dist/main.js');
const cloudflareEntry = join(repositoryRoot, 'mcps/cloudflare/dist/main.js');
const gatewayUrl = new URL('http://127.0.0.1:8790/cloudflare/mcp');
const backendUrl = new URL('http://127.0.0.1:8701/mcp');
const modernProtocolVersion = '2026-07-28';

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ManagedChild {
  process: ChildProcess;
  exit: Promise<ChildExit>;
  stderr(): string;
}

interface JsonRpcErrorBody {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${milliseconds} ms`)),
      milliseconds,
    );
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function processEnvironment(
  tokenFile: string,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const variable of [
    'NODE_ENV',
    'TN_AUTH_MODE',
    'TN_BIND_HOST',
    'TN_DEV_TOKEN_FILE',
    'TN_LOG_LEVEL',
    'TN_PORT',
    'TN_PUBLIC_BASE_URL',
    'TN_RATE_LIMIT_PER_MINUTE',
  ]) {
    delete env[variable];
  }
  Object.assign(env, {
    NODE_ENV: 'development',
    TN_AUTH_MODE: 'dev',
    TN_BIND_HOST: '127.0.0.1',
    TN_DEV_TOKEN_FILE: tokenFile,
    TN_LOG_LEVEL: 'silent',
    ...overrides,
  });
  for (const [variable, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[variable];
    }
  }
  return env;
}

function spawnBuilt(entry: string, env: NodeJS.ProcessEnv): ManagedChild {
  const child = spawn(process.execPath, [entry], {
    cwd: repositoryRoot,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderrChunks: Buffer[] = [];
  child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  const exit = new Promise<ChildExit>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    process: child,
    exit,
    stderr: () => Buffer.concat(stderrChunks).toString('utf8'),
  };
}

function safeStderr(
  child: ManagedChild,
  token: string,
  hiddenValues: readonly string[] = [],
): string {
  return [token, ...hiddenValues]
    .filter((value) => value.length > 0)
    .reduce((output, value) => output.replaceAll(value, '[REDACTED]'), child.stderr());
}

async function stopChild(child: ManagedChild | undefined): Promise<ChildExit | undefined> {
  if (child === undefined) {
    return undefined;
  }
  if (child.process.exitCode !== null || child.process.signalCode !== null) {
    return child.exit;
  }
  child.process.kill('SIGTERM');
  try {
    return await withTimeout(child.exit, 3_000, 'child SIGTERM exit');
  } catch {
    child.process.kill('SIGKILL');
    return withTimeout(child.exit, 3_000, 'child SIGKILL exit');
  }
}

async function assertPortFree(port: number): Promise<void> {
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () => {
        probe.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    throw new Error(
      `Phase 2 E2E prerequisite failed: 127.0.0.1:${port} is already in use; stop the occupying process and retry`,
      { cause: error },
    );
  } finally {
    if (probe.listening) {
      await new Promise<void>((resolve, reject) => {
        probe.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  }
}

function tcpAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectTcp({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  failureMessage: () => string,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(50);
  }
  throw new Error(failureMessage());
}

// Readiness must not hang on a child that died: the exit promise is raced against the
// readiness probe and turns an early exit into a failure carrying the child's stderr.
async function waitUntilChildReady(
  child: ManagedChild,
  token: string,
  label: string,
  predicate: () => Promise<boolean>,
): Promise<void> {
  const earlyExit = child.exit.then((exit: ChildExit): never => {
    throw new Error(
      `${label} exited before it was ready (code ${exit.code}, signal ${exit.signal}): ${safeStderr(child, token)}`,
    );
  });
  earlyExit.catch(() => undefined);

  await Promise.race([
    waitUntil(predicate, 5_000, () => `${label} did not become ready: ${safeStderr(child, token)}`),
    earlyExit,
  ]);
}

async function fetchHealthy(
  url: string,
  check: (body: Record<string, unknown>) => boolean,
): Promise<boolean> {
  try {
    const response = await fetch(url);
    if (response.status !== 200) {
      return false;
    }
    return check((await response.json()) as Record<string, unknown>);
  } catch {
    return false;
  }
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) {
    return;
  }
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function authenticatedHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };
}

function modernBody(method: string, version = modernProtocolVersion, params: object = {}): object {
  return {
    jsonrpc: '2.0',
    id: 41,
    method,
    params: {
      ...params,
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: version,
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
    },
  };
}

function modernHeaders(token: string, method: string, version = modernProtocolVersion) {
  return {
    ...authenticatedHeaders(token),
    'mcp-protocol-version': version,
    'mcp-method': method,
  };
}

async function postRaw(
  url: URL,
  token: string,
  body: string,
  headers: Record<string, string> = authenticatedHeaders(token),
): Promise<{ status: number; body: unknown; text: string }> {
  const response = await fetch(url, { method: 'POST', headers, body });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, text };
}

function jsonRpcError(body: unknown): JsonRpcErrorBody {
  expect(body).toMatchObject({ jsonrpc: '2.0', error: { code: expect.any(Number) } });
  return body as JsonRpcErrorBody;
}

async function connectClient(token: string, modern: boolean): Promise<Client> {
  const client = new Client(
    { name: 'phase-2-built-e2e', version: '1.0.0' },
    modern ? { versionNegotiation: { mode: 'auto' } } : {},
  );
  await client.connect(
    new StreamableHTTPClientTransport(gatewayUrl, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

describe('Phase 2 built-process E2E', () => {
  let directory = '';
  let tokenFile = '';
  let weakTokenFile = '';
  let token = '';
  let gateway: ManagedChild | undefined;
  let cloudflare: ManagedChild | undefined;
  let drainBackend: Server | undefined;

  beforeAll(async () => {
    await assertPortFree(8790);
    await assertPortFree(8701);
    directory = await mkdtemp(join(tmpdir(), 'tn-phase-2-e2e-'));
    tokenFile = join(directory, 'dev-token');
    weakTokenFile = join(directory, 'weak-dev-token');
    token = ['phase', 'two', process.pid.toString(36), Date.now().toString(36)].join('-');
    await writeFile(tokenFile, token, { mode: 0o600 });
    await writeFile(weakTokenFile, token, { mode: 0o600 });

    const startedCloudflare = spawnBuilt(cloudflareEntry, processEnvironment(tokenFile));
    cloudflare = startedCloudflare;
    const startedGateway = spawnBuilt(gatewayEntry, processEnvironment(tokenFile));
    gateway = startedGateway;

    await waitUntilChildReady(startedCloudflare, token, 'cloudflare backend', () =>
      fetchHealthy('http://127.0.0.1:8701/healthz', (body) => body.server === 'cloudflare'),
    );
    await waitUntilChildReady(startedGateway, token, 'gateway', () =>
      fetchHealthy('http://127.0.0.1:8790/healthz', (body) => body.status === 'ok'),
    );
  });

  afterAll(async () => {
    await stopChild(gateway);
    await stopChild(cloudflare);
    await closeServer(drainBackend);
    if (directory.length > 0) {
      await rm(directory, { recursive: true });
    }
  });

  it('auto-negotiates modern MCP through the built processes', async () => {
    const client = await connectClient(token, true);
    try {
      expect(client.getProtocolEra()).toBe('modern');
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toEqual(['tn_status']);
      const result = await client.callTool({ name: 'tn_status', arguments: {} });
      expect(result.structuredContent).toEqual({
        server: 'cloudflare',
        version: '0.0.0',
        specRevision: modernProtocolVersion,
        era: 'modern',
      });
    } finally {
      await client.close();
    }
  });

  it('uses legacy MCP through the built processes by default', async () => {
    const client = await connectClient(token, false);
    try {
      expect(client.getProtocolEra()).toBe('legacy');
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toEqual(['tn_status']);
      const result = await client.callTool({ name: 'tn_status', arguments: {} });
      expect(result.structuredContent).toEqual({
        server: 'cloudflare',
        version: '0.0.0',
        specRevision: modernProtocolVersion,
        era: 'legacy',
      });
    } finally {
      await client.close();
    }
  });

  it('serves a /healthz version matching the gateway package', async () => {
    const response = await fetch('http://127.0.0.1:8790/healthz');
    expect(response.status).toBe(200);

    const packageJson = JSON.parse(
      await readFile(join(repositoryRoot, 'gateway/package.json'), 'utf8'),
    ) as { version: string };
    expect(await response.json()).toEqual({ status: 'ok', version: packageJson.version });
  });

  it('accepts a raw legacy JSON-RPC notification with no id', async () => {
    const response = await postRaw(
      gatewayUrl,
      token,
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );

    // MCP 2025-03-26 §2.1 (Streamable HTTP): notifications without an id are answered
    // with 202 Accepted and an empty body. Assert the actual SDK behavior.
    expect(response.status).toBe(202);
    expect(response.text).toBe('');
  });

  it('rejects text/plain content with the SDK media-type error', async () => {
    const requestBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const response = await postRaw(gatewayUrl, token, requestBody, {
      ...authenticatedHeaders(token),
      'content-type': 'text/plain',
    });
    expect(response.status).toBe(415);
    expect(jsonRpcError(response.body).error.code).toBe(-32_000);
  });

  it('rejects Accept without text/event-stream with the SDK accept error', async () => {
    const requestBody = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' });
    const response = await postRaw(gatewayUrl, token, requestBody, {
      ...authenticatedHeaders(token),
      accept: 'application/json',
    });
    expect(response.status).toBe(406);
    expect(jsonRpcError(response.body).error.code).toBe(-32_000);
  });

  it('rejects malformed JSON as a parse error', async () => {
    const response = await postRaw(gatewayUrl, token, '{"jsonrpc":');
    expect(response.status).toBe(400);
    expect(jsonRpcError(response.body).error.code).toBe(-32_700);
  });

  it('rejects valid JSON that is not JSON-RPC', async () => {
    const response = await postRaw(gatewayUrl, token, JSON.stringify({ message: 'not JSON-RPC' }));
    expect(response.status).toBe(400);
    expect(jsonRpcError(response.body).error.code).toBe(-32_600);
  });

  it('rejects a modern JSON-RPC batch array', async () => {
    const response = await postRaw(
      gatewayUrl,
      token,
      JSON.stringify([modernBody('ping')]),
      modernHeaders(token, 'ping'),
    );
    expect(response.status).toBe(400);
    expect(jsonRpcError(response.body).error.code).toBe(-32_600);
  });

  it('rejects an unsupported modern protocol version and lists supported versions', async () => {
    const unsupportedVersion = '1900-01-01';
    const response = await postRaw(
      gatewayUrl,
      token,
      JSON.stringify(modernBody('ping', unsupportedVersion)),
      modernHeaders(token, 'ping', unsupportedVersion),
    );
    const error = jsonRpcError(response.body).error;
    expect(response.status).toBe(400);
    expect(error.code).toBe(-32_022);
    expect(error.data).toMatchObject({
      supported: expect.arrayContaining([modernProtocolVersion]),
    });
  });

  it('rejects an unknown modern method', async () => {
    const method = 'unknown/method';
    const response = await postRaw(
      gatewayUrl,
      token,
      JSON.stringify(modernBody(method)),
      modernHeaders(token, method),
    );
    expect(response.status).toBe(404);
    expect(jsonRpcError(response.body).error.code).toBe(-32_601);
  });

  it('rejects a Mcp-Method header that mismatches the modern body', async () => {
    const response = await postRaw(
      gatewayUrl,
      token,
      JSON.stringify(modernBody('tools/list')),
      modernHeaders(token, 'ping'),
    );
    expect(response.status).toBe(400);
    expect(jsonRpcError(response.body).error.code).toBe(-32_020);
  });

  it('rejects tools/call without Mcp-Name', async () => {
    const method = 'tools/call';
    const response = await postRaw(
      gatewayUrl,
      token,
      JSON.stringify(
        modernBody(method, modernProtocolVersion, { name: 'tn_status', arguments: {} }),
      ),
      modernHeaders(token, method),
    );
    expect(response.status).toBe(400);
    expect(jsonRpcError(response.body).error.code).toBe(-32_020);
  });

  it('rejects a client Bearer token sent directly to the backend', async () => {
    const response = await postRaw(backendUrl, token, '{}');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
  });

  it('rejects a wrong dev assertion sent directly to the backend', async () => {
    const response = await postRaw(backendUrl, token, '{}', {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'x-tn-dev-assertion': 'wrong-assertion',
    });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
  });

  it('rejects a gateway request with no Bearer token', async () => {
    const response = await postRaw(gatewayUrl, token, '{}', {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
  });

  it('rejects a gateway request with an invalid Bearer token', async () => {
    const response = await postRaw(gatewayUrl, token, '{}', {
      ...authenticatedHeaders('wrong-bearer'),
    });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
  });

  it('rejects a hostile Origin at the gateway', async () => {
    const response = await postRaw(gatewayUrl, token, '{}', {
      ...authenticatedHeaders(token),
      origin: 'https://evil.example',
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'forbidden' });
  });

  it('propagates modern client cancellation to an in-process tool signal', async () => {
    let markSignalObserved: (() => void) | undefined;
    const signalObserved = new Promise<void>((resolve) => {
      markSignalObserved = resolve;
    });
    const slowTool = defineTool({
      name: 'test_slow',
      description: 'Waits for cancellation to prove the request abort signal reaches tool code.',
      provider: 'cloudflare',
      risk: 'R0',
      scopes: ['tn:read'],
      approval: 'never',
      input: tnStatusTool.input,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async handler(_args, context) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 10_000);
          const observeAbort = () => {
            clearTimeout(timer);
            markSignalObserved?.();
            resolve();
          };
          if (context.signal.aborted) {
            observeAbort();
          } else {
            context.signal.addEventListener('abort', observeAbort, { once: true });
          }
        });
        return { content: [{ type: 'text', text: 'cancelled' }] };
      },
    });
    let backend: RunningMcpBackend | undefined;
    let localGateway: RunningGateway | undefined;
    let client: Client | undefined;
    try {
      backend = await startMcpBackend({
        processName: 'cloudflare',
        version: 'cancellation-test',
        tools: [slowTool],
        env: processEnvironment(tokenFile),
        listenPortOverride: 0,
      });
      localGateway = await startGateway({
        env: processEnvironment(tokenFile),
        listenPortOverride: 0,
        routeTargets: { cloudflare: backend.url },
      });
      client = new Client(
        { name: 'phase-2-cancellation', version: '1.0.0' },
        { versionNegotiation: { mode: 'auto' } },
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL('/cloudflare/mcp', localGateway.url), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      const controller = new AbortController();
      const call = client.callTool(
        { name: slowTool.name, arguments: {} },
        { signal: controller.signal },
      );
      await delay(200);
      controller.abort();
      await expect(call).rejects.toThrow();
      await withTimeout(signalObserved, 2_000, 'tool abort signal');
    } finally {
      await client?.close();
      await localGateway?.close();
      await backend?.close();
    }
  });

  it('drains an in-flight request and refuses new connections on SIGTERM', async () => {
    const backendExit = await stopChild(cloudflare);
    expect(backendExit).toEqual({ code: 0, signal: null });
    cloudflare = undefined;

    let markRequestReceived: (() => void) | undefined;
    const requestReceived = new Promise<void>((resolve) => {
      markRequestReceived = resolve;
    });
    drainBackend = createServer((_request, response) => {
      markRequestReceived?.();
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ drained: true }));
      }, 800);
    });
    await listen(drainBackend, 8701);

    const activeGateway = gateway;
    if (activeGateway === undefined) {
      throw new Error('spawned gateway was not available for the drain test');
    }
    const inFlight = postRaw(gatewayUrl, token, '{}');
    await withTimeout(requestReceived, 2_000, 'drain backend receipt');
    await delay(100);
    const signalSentAt = performance.now();
    expect(activeGateway.process.kill('SIGTERM')).toBe(true);

    await waitUntil(
      async () => !(await tcpAccepts(8790)),
      2_000,
      () => 'gateway continued accepting new connections after SIGTERM',
    );
    const response = await withTimeout(inFlight, 3_000, 'in-flight gateway request');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ drained: true });

    const gatewayExit = await withTimeout(activeGateway.exit, SHUTDOWN_DRAIN_MS, 'gateway drain');
    expect(gatewayExit).toEqual({ code: 0, signal: null });
    expect(performance.now() - signalSentAt).toBeLessThan(SHUTDOWN_DRAIN_MS);
    gateway = undefined;
    await closeServer(drainBackend);
    drainBackend = undefined;
  });

  async function expectStartupRefusal(
    entry: string,
    overrides: Record<string, string | undefined>,
    namedVariables: readonly string[],
    receivedValues: readonly string[],
  ): Promise<void> {
    const child = spawnBuilt(entry, processEnvironment(tokenFile, overrides));
    let result: ChildExit;
    try {
      result = await withTimeout(child.exit, 3_000, `${entry} startup refusal`);
    } catch (error) {
      await stopChild(child);
      throw error;
    }
    const stderr = child.stderr();
    const safeOutput = safeStderr(child, token, receivedValues);
    expect(result, safeOutput).toEqual({ code: 1, signal: null });
    for (const variable of namedVariables) {
      expect(stderr.includes(variable), safeOutput).toBe(true);
    }
    for (const value of [token, ...receivedValues]) {
      expect(stderr.includes(value), safeOutput).toBe(false);
    }
    expect(stderr.trim().split('\n'), safeOutput).toHaveLength(1);
    expect(stderr.includes(' at '), safeOutput).toBe(false);
  }

  it('refuses gateway startup with TN_BIND_HOST=0.0.0.0', async () => {
    await expectStartupRefusal(
      gatewayEntry,
      { TN_BIND_HOST: '0.0.0.0' },
      ['TN_BIND_HOST'],
      ['0.0.0.0'],
    );
  });

  it('refuses gateway dev auth in production', async () => {
    await expectStartupRefusal(
      gatewayEntry,
      { NODE_ENV: 'production' },
      ['TN_AUTH_MODE', 'NODE_ENV'],
      ['production'],
    );
  });

  it('refuses gateway dev auth with a public base URL', async () => {
    const publicUrl = 'https://mcp.telosnexus.cloud';
    await expectStartupRefusal(
      gatewayEntry,
      { TN_PUBLIC_BASE_URL: publicUrl },
      ['TN_AUTH_MODE', 'TN_PUBLIC_BASE_URL'],
      [publicUrl],
    );
  });

  it('refuses gateway access auth with the Phase 4 message', async () => {
    await expectStartupRefusal(
      gatewayEntry,
      { TN_AUTH_MODE: 'access' },
      ['TN_AUTH_MODE', 'Phase 4'],
      ['access'],
    );
  });

  it('refuses gateway startup with a mode-0644 dev token file', async () => {
    await chmod(weakTokenFile, 0o644);
    await expectStartupRefusal(
      gatewayEntry,
      { TN_DEV_TOKEN_FILE: weakTokenFile },
      ['TN_DEV_TOKEN_FILE'],
      [weakTokenFile],
    );
  });

  it('refuses cloudflare startup with TN_BIND_HOST=0.0.0.0', async () => {
    await expectStartupRefusal(
      cloudflareEntry,
      { TN_BIND_HOST: '0.0.0.0' },
      ['TN_BIND_HOST'],
      ['0.0.0.0'],
    );
  });

  it('fails readiness immediately when a spawned child exits before it is ready', async () => {
    const dying = spawnBuilt(
      cloudflareEntry,
      processEnvironment(tokenFile, { TN_BIND_HOST: '0.0.0.0' }),
    );
    try {
      await expect(
        waitUntilChildReady(dying, token, 'unready cloudflare backend', () =>
          fetchHealthy('http://127.0.0.1:8701/healthz', (body) => body.server === 'cloudflare'),
        ),
      ).rejects.toThrow(/exited before it was ready.*TN_BIND_HOST/s);
    } finally {
      await stopChild(dying);
    }
  });
});
