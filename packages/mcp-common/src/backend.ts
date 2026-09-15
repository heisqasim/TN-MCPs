import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/node';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { createAuthenticator } from '@tn-mcps/auth';
import {
  devModeEdgeHeaders,
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  loadProcessConfig,
  MAX_BODY_BYTES,
  type ProcessName,
  REQUEST_TIMEOUT_MS,
  SHUTDOWN_DRAIN_MS,
} from '@tn-mcps/config';
import { acceptOrCreateRequestId, createLogger, REQUEST_ID_HEADER } from '@tn-mcps/observability';
import { createHttpLifecycle, redact } from '@tn-mcps/shared';

import type { Logger, ToolDefinition } from './contract.js';
import { createTelosMcpServer } from './server.js';

const VERIFIED_PRINCIPAL_TOKEN = 'tn-verified-principal';
const validateLoopbackHost = hostHeaderValidation(['localhost', '127.0.0.1', '[::1]']);
const rejectEveryOrigin = originValidation([]);

export interface StartMcpBackendOptions {
  processName: Exclude<ProcessName, 'gateway'>;
  version: string;
  tools?: readonly ToolDefinition[];
  env?: Record<string, string | undefined>;
  listenPortOverride?: number;
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
  logger?: Logger;
  installSignalHandlers?: boolean;
}

export interface RunningMcpBackend {
  url: string;
  close(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (response.headersSent || response.writableEnded || response.destroyed) {
    return;
  }
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(serialized).toString(),
  });
  response.end(serialized);
}

// A rejected request must never hold a keep-alive connection with a pending body: the
// response declares `Connection: close`, the remaining body is drained under a hard
// bound, and the socket is then destroyed so no client-side reuse is possible.
const REJECTION_DRAIN_MS = 1_000;
const REJECTION_DRAIN_BYTES = 65_536;

function beginRejectionTeardown(request: IncomingMessage, response: ServerResponse): () => void {
  response.setHeader('connection', 'close');
  let settled = false;
  let drained = 0;
  const drainChunk = (chunk: Buffer | string): void => {
    drained += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (drained > REJECTION_DRAIN_BYTES) {
      teardown();
    }
  };
  const teardown = () => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(hardBound);
    request.off('data', drainChunk);
    request.socket?.destroy();
  };
  const cancel = () => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(hardBound);
    request.off('data', drainChunk);
    request.off('aborted', teardown);
    request.off('error', teardown);
    response.off('close', teardown);
  };
  const hardBound = setTimeout(teardown, REJECTION_DRAIN_MS);
  hardBound.unref();
  request.once('aborted', teardown);
  request.once('error', teardown);
  response.once('close', teardown);
  return cancel;
}

function rejectJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  beginRejectionTeardown(request, response);
  sendJson(response, status, body);
}

function runRejectionGuard(
  request: IncomingMessage,
  response: ServerResponse,
  guard: (request: IncomingMessage, response: ServerResponse) => boolean,
): boolean {
  const cancelTeardown = beginRejectionTeardown(request, response);
  if (!guard(request, response)) {
    return false;
  }
  cancelTeardown();
  response.removeHeader('connection');
  return true;
}

async function readLimitedJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentLength = request.headers['content-length'];
  if (typeof contentLength === 'string' && Number(contentLength) > MAX_BODY_BYTES) {
    throw new RangeError('request body exceeded limit');
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      throw new RangeError('request body exceeded limit');
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(body);
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? '/', 'http://localhost').pathname;
}

function formatListenUrl(host: string, port: number): string {
  const urlHost = host.includes(':') ? `[${host}]` : host;
  return `http://${urlHost}:${port}/mcp`;
}

export async function startMcpBackend(options: StartMcpBackendOptions): Promise<RunningMcpBackend> {
  const config = loadProcessConfig(options.processName, options.env);
  if (config.nodeEnv === 'production') {
    if (options.listenPortOverride !== undefined) {
      throw new Error('listenPortOverride is test-only and cannot be used in production');
    }
    if (options.headersTimeoutMs !== undefined) {
      throw new Error('headersTimeoutMs is test-only and cannot be used in production');
    }
    if (options.requestTimeoutMs !== undefined) {
      throw new Error('requestTimeoutMs is test-only and cannot be used in production');
    }
  }
  const headersTimeoutMs = options.headersTimeoutMs ?? HEADERS_TIMEOUT_MS;
  if (!Number.isFinite(headersTimeoutMs) || headersTimeoutMs <= 0) {
    throw new RangeError('headersTimeoutMs must be a positive finite number');
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new RangeError('requestTimeoutMs must be a positive finite number');
  }
  const authenticator = createAuthenticator(config, 'backend');
  const logger =
    options.logger ?? createLogger({ name: options.processName, level: config.logLevel });
  const mcp = createTelosMcpServer({
    name: options.processName,
    version: options.version,
    logger,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  });

  const httpServer = createServer(
    {
      requestTimeout: REQUEST_TIMEOUT_MS,
      headersTimeout: headersTimeoutMs,
      keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
      connectionsCheckingInterval: Math.min(headersTimeoutMs, 1_000),
    },
    (request, response) => {
      const requestId = acceptOrCreateRequestId(request.headers[REQUEST_ID_HEADER]);
      request.headers[REQUEST_ID_HEADER] = requestId;
      response.setHeader(REQUEST_ID_HEADER, requestId);
      const startedAt = performance.now();
      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        logger.warn({ requestId }, 'request timed out');
        if (response.headersSent) {
          // An already-started response (e.g. an SSE stream) cannot take a status
          // line anymore: writeHead would throw ERR_HTTP_HEADERS_SENT here and the
          // uncaught exception would kill the process. Terminate the stream instead.
          response.destroy();
        } else {
          sendJson(response, 504, { error: 'request timed out' });
        }
        request.destroy();
      }, requestTimeoutMs);
      timeout.unref();

      response.once('finish', () => {
        clearTimeout(timeout);
        logger.info(
          {
            durationMs: Math.round(performance.now() - startedAt),
            method: request.method,
            path: requestPath(request),
            requestId,
            statusCode: response.statusCode,
          },
          'request completed',
        );
      });
      response.once('close', () => clearTimeout(timeout));

      void (async () => {
        const edgeHeaders = devModeEdgeHeaders(config.authMode, request.headers);
        if (edgeHeaders.length > 0) {
          logger.warn(
            { edgeHeaders: redact(edgeHeaders), requestId },
            'edge headers rejected in dev auth mode',
          );
          rejectJson(request, response, 403, { error: 'forbidden' });
          return;
        }
        const path = requestPath(request);
        if (path === '/healthz' && request.method === 'GET') {
          sendJson(response, 200, {
            status: 'ok',
            server: options.processName,
            version: options.version,
          });
          return;
        }
        if (path !== '/mcp') {
          rejectJson(request, response, 404, { error: 'not found' });
          return;
        }
        if (request.method === 'GET' || request.method === 'DELETE') {
          response.setHeader('allow', 'POST');
          rejectJson(request, response, 405, { error: 'method not allowed' });
          return;
        }
        if (request.method !== 'POST') {
          response.setHeader('allow', 'POST');
          rejectJson(request, response, 405, { error: 'method not allowed' });
          return;
        }
        if (!runRejectionGuard(request, response, validateLoopbackHost)) {
          return;
        }
        if (!runRejectionGuard(request, response, rejectEveryOrigin)) {
          return;
        }

        const authentication = await authenticator.authenticate(request.headers);
        if (!authentication.ok) {
          logger.warn({ reason: authentication.reason, requestId }, 'authentication failed');
          rejectJson(request, response, 401, { error: 'unauthorized' });
          return;
        }

        let parsedBody: unknown;
        try {
          parsedBody = await readLimitedJsonBody(request);
        } catch (error) {
          if (timedOut) {
            return;
          }
          if (error instanceof RangeError) {
            rejectJson(request, response, 413, { error: 'request body too large' });
            return;
          }
          rejectJson(request, response, 400, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          });
          return;
        }

        const authInfo: AuthInfo = {
          token: VERIFIED_PRINCIPAL_TOKEN,
          clientId: authentication.principal.id,
          scopes: [...authentication.principal.scopes],
          extra: { principalKind: authentication.principal.kind },
        };
        const authenticatedRequest = request as IncomingMessage & {
          auth: AuthInfo;
          method: string;
          url: string;
        };
        authenticatedRequest.auth = authInfo;
        await mcp.nodeHandler(authenticatedRequest, response, parsedBody);
      })().catch((error: unknown) => {
        logger.error({ error: redact(error), requestId }, 'request failed');
        if (!response.headersSent) {
          rejectJson(request, response, 500, { error: 'internal server error' });
        } else if (!response.writableEnded) {
          response.destroy();
        }
      });
    },
  );

  const lifecycle = createHttpLifecycle(httpServer, { drainMs: SHUTDOWN_DRAIN_MS });
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= lifecycle.shutdown().finally(() => mcp.close());
    return closePromise;
  };

  const logShutdownFailure = (error: unknown) => {
    logger.error({ error: redact(error) }, 'MCP backend shutdown failed');
    process.exitCode = 1;
  };

  const signalHandler = () => {
    void close().catch(logShutdownFailure);
  };
  if (options.installSignalHandlers === true) {
    process.once('SIGTERM', signalHandler);
    process.once('SIGINT', signalHandler);
  }

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(options.listenPortOverride ?? config.port, config.bindHost, () => {
        httpServer.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    process.off('SIGTERM', signalHandler);
    process.off('SIGINT', signalHandler);
    await close().catch(logShutdownFailure);
    throw error;
  }

  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    await close();
    throw new Error('MCP backend did not bind a TCP address');
  }

  return {
    url: formatListenUrl(config.bindHost, address.port),
    async close() {
      process.off('SIGTERM', signalHandler);
      process.off('SIGINT', signalHandler);
      await close();
    },
  };
}
