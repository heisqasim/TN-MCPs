import { readFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';

import {
  ACCESS_ASSERTION_HEADER,
  createAuthenticator,
  DEV_ASSERTION_HEADER,
  type Principal,
} from '@tn-mcps/auth';
import {
  isLoopbackHost,
  loadProcessConfig,
  MAX_BODY_BYTES,
  PROCESS_PORTS,
  type ProcessName,
  REQUEST_TIMEOUT_MS,
  ROUTES,
  type Route,
  SHUTDOWN_DRAIN_MS,
} from '@tn-mcps/config';
import { acceptOrCreateRequestId, createLogger, REQUEST_ID_HEADER } from '@tn-mcps/observability';
import { createHttpLifecycle } from '@tn-mcps/shared';

type BackendProcessName = Exclude<ProcessName, 'gateway'>;

interface PackageMetadata {
  version: string;
}

export interface StartGatewayOptions {
  env?: Record<string, string | undefined>;
  listenPortOverride?: number;
  routeTargets?: Partial<Record<BackendProcessName, string | URL>>;
  upstreamTimeoutMs?: number;
  installSignalHandlers?: boolean;
}

export interface RunningGateway {
  url: string;
  close(): Promise<void>;
}

interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const packageMetadata = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageMetadata;
const gatewayVersion = packageMetadata.version;

const EXACT_REQUEST_HEADERS = new Set([
  'content-type',
  'accept',
  'content-length',
  'mcp-protocol-version',
  'mcp-method',
  'mcp-name',
  'user-agent',
]);
const EXACT_RESPONSE_HEADERS = new Set(['content-type', 'cache-control', 'x-accel-buffering']);

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

function requestPath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? '/', 'http://gateway.invalid').pathname;
  } catch {
    return '/';
  }
}

function hostnameFromHostHeader(header: string | undefined): string | undefined {
  if (header === undefined || header.length === 0) {
    return undefined;
  }
  try {
    const parsed = new URL(`http://${header}`);
    if (
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== '/' ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return undefined;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function allowedHostnames(publicBaseUrl: string | undefined): ReadonlySet<string> {
  const allowed = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (publicBaseUrl !== undefined) {
    allowed.add(new URL(publicBaseUrl).hostname.toLowerCase());
  }
  return allowed;
}

function allowedOrigins(
  publicBaseUrl: string | undefined,
  listenPort: number,
): ReadonlySet<string> {
  if (publicBaseUrl !== undefined) {
    return new Set([new URL(publicBaseUrl).origin]);
  }
  return new Set([`http://127.0.0.1:${listenPort}`, `http://localhost:${listenPort}`]);
}

function originIsAllowed(
  origin: string | string[] | undefined,
  allowed: ReadonlySet<string>,
): boolean {
  return origin === undefined || (typeof origin === 'string' && allowed.has(origin));
}

function findRoute(path: string): Route | undefined {
  return ROUTES.find((route) => route.path === path);
}

function normalizeTarget(input: string | URL): URL {
  const target = new URL(input.toString());
  const hostname =
    target.hostname.startsWith('[') && target.hostname.endsWith(']')
      ? target.hostname.slice(1, -1)
      : target.hostname;
  if (
    target.protocol !== 'http:' ||
    !isLoopbackHost(hostname) ||
    target.username.length > 0 ||
    target.password.length > 0 ||
    target.search.length > 0 ||
    target.hash.length > 0
  ) {
    throw new Error('Gateway route targets must be plain loopback HTTP URLs');
  }
  if (target.pathname === '/' || target.pathname.length === 0) {
    target.pathname = '/mcp';
  }
  return target;
}

function targetHostHeader(target: URL): string {
  if (target.port.length > 0) {
    return target.host;
  }
  return `${target.hostname}:${target.protocol === 'http:' ? '80' : '443'}`;
}

function buildRouteTargets(
  overrides: StartGatewayOptions['routeTargets'],
): ReadonlyMap<BackendProcessName, URL> {
  const targets = new Map<BackendProcessName, URL>();
  for (const route of ROUTES) {
    const configured = overrides?.[route.process];
    const target = configured ?? `http://127.0.0.1:${PROCESS_PORTS[route.process]}`;
    targets.set(route.process, normalizeTarget(target));
  }
  return targets;
}

function requestHeadersForUpstream(
  headers: IncomingHttpHeaders,
  requestId: string,
): OutgoingHttpHeaders {
  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      value !== undefined &&
      (EXACT_REQUEST_HEADERS.has(normalized) || normalized.startsWith('mcp-param-'))
    ) {
      forwarded[normalized] = value;
    }
  }
  forwarded[REQUEST_ID_HEADER] = requestId;
  return forwarded;
}

function copyResponseHeaders(upstream: IncomingMessage, response: ServerResponse): void {
  for (const [name, value] of Object.entries(upstream.headers)) {
    const normalized = name.toLowerCase();
    if (
      value !== undefined &&
      (EXACT_RESPONSE_HEADERS.has(normalized) || normalized.startsWith('mcp-'))
    ) {
      response.setHeader(normalized, value);
    }
  }

  const contentType = upstream.headers['content-type'];
  if (
    typeof contentType === 'string' &&
    contentType.toLowerCase().startsWith('text/event-stream')
  ) {
    response.setHeader('x-accel-buffering', 'no');
  }
}

function devCredential(headers: IncomingHttpHeaders): string | undefined {
  const authorization = headers.authorization;
  if (typeof authorization !== 'string') {
    return undefined;
  }
  return /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
}

function addIdentityAssertion(
  forwarded: OutgoingHttpHeaders,
  headers: IncomingHttpHeaders,
  authMode: 'access' | 'dev',
): boolean {
  if (authMode === 'dev') {
    const credential = devCredential(headers);
    if (credential === undefined) {
      return false;
    }
    forwarded[DEV_ASSERTION_HEADER] = credential;
    return true;
  }

  const assertion = headers[ACCESS_ASSERTION_HEADER];
  if (typeof assertion !== 'string') {
    return false;
  }
  forwarded[ACCESS_ASSERTION_HEADER] = assertion;
  return true;
}

function contentLengthExceedsLimit(headers: IncomingHttpHeaders): boolean {
  const value = headers['content-length'];
  if (typeof value !== 'string') {
    return false;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > MAX_BODY_BYTES;
}

function createRateLimiter(ratePerMinute: number) {
  const buckets = new Map<string, Bucket>();
  const refillPerMillisecond = ratePerMinute / 60_000;

  return (principal: Principal): RateLimitDecision => {
    const now = performance.now();
    const bucket = buckets.get(principal.id) ?? { tokens: ratePerMinute, updatedAt: now };
    bucket.tokens = Math.min(
      ratePerMinute,
      bucket.tokens + (now - bucket.updatedAt) * refillPerMillisecond,
    );
    bucket.updatedAt = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      buckets.set(principal.id, bucket);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    buckets.set(principal.id, bucket);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMillisecond / 1_000)),
    };
  };
}

function formatListenUrl(host: string, port: number): string {
  const urlHost = host.includes(':') ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

export async function startGateway(options: StartGatewayOptions = {}): Promise<RunningGateway> {
  const config = loadProcessConfig('gateway', options.env);
  const authenticator = createAuthenticator(config, 'gateway');
  const targets = buildRouteTargets(options.routeTargets);
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(upstreamTimeoutMs) || upstreamTimeoutMs <= 0) {
    throw new RangeError('upstreamTimeoutMs must be a positive finite number');
  }

  const logger = createLogger({ name: 'gateway', level: config.logLevel });
  const takeRateLimitToken = createRateLimiter(config.rateLimitPerMinute);
  let activeListenPort = options.listenPortOverride ?? config.port;
  let hosts = allowedHostnames(config.publicBaseUrl);
  let origins = allowedOrigins(config.publicBaseUrl, activeListenPort);

  const httpServer = createServer((request, response) => {
    const requestId = acceptOrCreateRequestId(request.headers[REQUEST_ID_HEADER]);
    request.headers[REQUEST_ID_HEADER] = requestId;
    response.setHeader(REQUEST_ID_HEADER, requestId);
    const routePath = requestPath(request);
    const startedAt = performance.now();
    let principalId: string | null = null;
    let logged = false;

    const logCompletion = () => {
      if (logged) {
        return;
      }
      logged = true;
      logger.info(
        {
          requestId,
          route: routePath,
          principalId,
          status: response.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'request completed',
      );
    };
    response.once('finish', logCompletion);
    response.once('close', () => {
      if (!response.writableEnded) {
        response.statusCode = 499;
      }
      logCompletion();
    });

    void (async () => {
      const hostname = hostnameFromHostHeader(request.headers.host);
      if (hostname === undefined || !hosts.has(hostname)) {
        sendJson(response, 403, { error: 'forbidden' });
        return;
      }
      if (!originIsAllowed(request.headers.origin, origins)) {
        sendJson(response, 403, { error: 'forbidden' });
        return;
      }

      if (routePath === '/healthz' && request.method === 'GET') {
        sendJson(response, 200, { status: 'ok', version: gatewayVersion });
        return;
      }

      const route = findRoute(routePath);
      if (route === undefined) {
        sendJson(response, 404, { error: 'not found' });
        return;
      }
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST');
        sendJson(response, 405, { error: 'method not allowed' });
        return;
      }

      if (contentLengthExceedsLimit(request.headers)) {
        response.setHeader('connection', 'close');
        sendJson(response, 413, { error: 'request body too large' });
        request.resume();
        return;
      }

      const authentication = await authenticator.authenticate(request.headers);
      if (!authentication.ok) {
        sendJson(response, 401, { error: 'unauthorized' });
        request.resume();
        return;
      }
      principalId = authentication.principal.id;

      const rateLimit = takeRateLimitToken(authentication.principal);
      if (!rateLimit.allowed) {
        response.setHeader('retry-after', rateLimit.retryAfterSeconds.toString());
        sendJson(response, 429, { error: 'rate limit exceeded' });
        request.resume();
        return;
      }

      const target = targets.get(route.process);
      if (target === undefined) {
        sendJson(response, 503, { error: 'backend unavailable' });
        return;
      }
      const forwarded = requestHeadersForUpstream(request.headers, requestId);
      forwarded.host = targetHostHeader(target);
      if (!addIdentityAssertion(forwarded, request.headers, config.authMode)) {
        sendJson(response, 401, { error: 'unauthorized' });
        request.resume();
        return;
      }

      let bodyBytes = 0;
      let bodyTooLarge = false;
      let clientDisconnected = false;
      let upstreamTimedOut = false;
      let upstreamSettled = false;
      let requestBodyComplete = false;
      let pendingUpstreamResponse: IncomingMessage | undefined;

      const forwardUpstreamResponse = (upstreamResponse: IncomingMessage) => {
        if (bodyTooLarge || clientDisconnected || upstreamTimedOut) {
          upstreamResponse.destroy();
          return;
        }
        response.statusCode = upstreamResponse.statusCode ?? 502;
        copyResponseHeaders(upstreamResponse, response);
        upstreamResponse.once('end', () => {
          upstreamSettled = true;
          clearTimeout(timeout);
        });
        upstreamResponse.once('aborted', () => {
          upstreamSettled = true;
          clearTimeout(timeout);
          if (!response.writableEnded) {
            response.destroy();
          }
        });
        upstreamResponse.once('error', () => {
          upstreamSettled = true;
          clearTimeout(timeout);
          if (!response.writableEnded) {
            response.destroy();
          }
        });
        upstreamResponse.pipe(response);
      };

      const upstreamRequest = httpRequest(
        target,
        {
          method: 'POST',
          headers: forwarded,
          agent: false,
        },
        (upstreamResponse) => {
          if (!requestBodyComplete) {
            pendingUpstreamResponse = upstreamResponse;
            upstreamResponse.pause();
            return;
          }
          forwardUpstreamResponse(upstreamResponse);
        },
      );

      const timeout = setTimeout(() => {
        if (upstreamSettled || bodyTooLarge || clientDisconnected) {
          return;
        }
        upstreamTimedOut = true;
        upstreamRequest.destroy();
        pendingUpstreamResponse?.destroy();
        if (response.headersSent) {
          response.destroy();
        } else {
          sendJson(response, 504, { error: 'upstream timeout' });
        }
      }, upstreamTimeoutMs);
      timeout.unref();

      upstreamRequest.once('error', () => {
        clearTimeout(timeout);
        if (bodyTooLarge || clientDisconnected || upstreamTimedOut) {
          return;
        }
        upstreamSettled = true;
        if (response.headersSent) {
          response.destroy();
        } else {
          sendJson(response, 503, { error: 'backend unavailable' });
        }
      });

      const abortUpstream = () => {
        if (response.writableEnded || upstreamSettled || bodyTooLarge) {
          return;
        }
        clientDisconnected = true;
        clearTimeout(timeout);
        upstreamRequest.destroy();
        pendingUpstreamResponse?.destroy();
      };
      request.once('aborted', abortUpstream);
      response.once('close', abortUpstream);

      request.on('data', (chunk: Buffer | string) => {
        if (bodyTooLarge || clientDisconnected || upstreamTimedOut || upstreamSettled) {
          return;
        }
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bodyBytes += buffer.byteLength;
        if (bodyBytes > MAX_BODY_BYTES) {
          bodyTooLarge = true;
          clearTimeout(timeout);
          upstreamRequest.destroy();
          pendingUpstreamResponse?.destroy();
          if (response.headersSent) {
            response.destroy();
          } else {
            response.setHeader('connection', 'close');
            sendJson(response, 413, { error: 'request body too large' });
          }
          request.resume();
          return;
        }
        if (!upstreamRequest.write(buffer)) {
          request.pause();
          upstreamRequest.once('drain', () => request.resume());
        }
      });
      request.once('end', () => {
        requestBodyComplete = true;
        if (!bodyTooLarge && !clientDisconnected && !upstreamTimedOut && !upstreamSettled) {
          upstreamRequest.end();
          if (pendingUpstreamResponse !== undefined) {
            const upstreamResponse = pendingUpstreamResponse;
            pendingUpstreamResponse = undefined;
            forwardUpstreamResponse(upstreamResponse);
            upstreamResponse.resume();
          }
        }
      });
      request.once('error', abortUpstream);
    })().catch(() => {
      if (response.headersSent) {
        response.destroy();
      } else {
        sendJson(response, 500, { error: 'internal server error' });
      }
    });
  });

  const lifecycle = createHttpLifecycle(httpServer, { drainMs: SHUTDOWN_DRAIN_MS });
  const signalHandler = () => {
    void lifecycle.shutdown();
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
    await lifecycle.shutdown();
    throw new Error('Gateway did not bind a TCP address');
  }
  activeListenPort = address.port;
  hosts = allowedHostnames(config.publicBaseUrl);
  origins = allowedOrigins(config.publicBaseUrl, activeListenPort);

  return {
    url: formatListenUrl(config.bindHost, address.port),
    async close() {
      process.off('SIGTERM', signalHandler);
      process.off('SIGINT', signalHandler);
      await lifecycle.shutdown();
    },
  };
}
