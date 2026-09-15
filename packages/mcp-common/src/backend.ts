import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/node';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { createAuthenticator } from '@tn-mcps/auth';
import {
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
  logger?: Logger;
  installSignalHandlers?: boolean;
}

export interface RunningMcpBackend {
  url: string;
  close(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (response.writableEnded) {
    return;
  }
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(serialized).toString(),
  });
  response.end(serialized);
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
  const authenticator = createAuthenticator(config, 'backend');
  const logger =
    options.logger ?? createLogger({ name: options.processName, level: config.logLevel });
  const mcp = createTelosMcpServer({
    name: options.processName,
    version: options.version,
    logger,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  });

  const httpServer = createServer((request, response) => {
    const requestId = acceptOrCreateRequestId(request.headers[REQUEST_ID_HEADER]);
    request.headers[REQUEST_ID_HEADER] = requestId;
    response.setHeader(REQUEST_ID_HEADER, requestId);
    const startedAt = performance.now();
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      logger.warn({ requestId }, 'request timed out');
      sendJson(response, 504, { error: 'request timed out' });
      request.destroy();
    }, REQUEST_TIMEOUT_MS);
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
        sendJson(response, 404, { error: 'not found' });
        return;
      }
      if (request.method === 'GET' || request.method === 'DELETE') {
        response.setHeader('allow', 'POST');
        sendJson(response, 405, { error: 'method not allowed' });
        return;
      }
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST');
        sendJson(response, 405, { error: 'method not allowed' });
        return;
      }
      if (!validateLoopbackHost(request, response)) {
        return;
      }
      if (!rejectEveryOrigin(request, response)) {
        return;
      }

      const authentication = await authenticator.authenticate(request.headers);
      if (!authentication.ok) {
        logger.warn({ reason: authentication.reason, requestId }, 'authentication failed');
        sendJson(response, 401, { error: 'unauthorized' });
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
          response.setHeader('connection', 'close');
          sendJson(response, 413, { error: 'request body too large' });
          return;
        }
        sendJson(response, 400, {
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
        sendJson(response, 500, { error: 'internal server error' });
      } else if (!response.writableEnded) {
        response.destroy();
      }
    });
  });

  const lifecycle = createHttpLifecycle(httpServer, { drainMs: SHUTDOWN_DRAIN_MS });
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= lifecycle.shutdown().finally(() => mcp.close());
    return closePromise;
  };

  const signalHandler = () => {
    void close();
  };
  if (options.installSignalHandlers === true) {
    process.once('SIGTERM', signalHandler);
    process.once('SIGINT', signalHandler);
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.listenPortOverride ?? config.port, config.bindHost, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

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
