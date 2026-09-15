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
  type Authenticator,
  createAuthenticator,
  DEV_ASSERTION_HEADER,
  type Principal,
} from '@tn-mcps/auth';
import {
  devModeEdgeHeaders,
  HEADERS_TIMEOUT_MS,
  isLoopbackHost,
  KEEP_ALIVE_TIMEOUT_MS,
  loadProcessConfig,
  MAX_BODY_BYTES,
  PROCESS_PORTS,
  type ProcessName,
  REQUEST_TIMEOUT_MS,
  ROUTES,
  type Route,
  SHUTDOWN_DRAIN_MS,
} from '@tn-mcps/config';
import {
  createLogger,
  newRequestId,
  REQUEST_ID_HEADER,
  validRequestId,
} from '@tn-mcps/observability';
import { createHttpLifecycle, redact } from '@tn-mcps/shared';

type BackendProcessName = Exclude<ProcessName, 'gateway'>;

interface PackageMetadata {
  version: string;
}

export interface StartGatewayOptions {
  env?: Record<string, string | undefined>;
  listenPortOverride?: number;
  routeTargets?: Partial<Record<BackendProcessName, string | URL>>;
  upstreamTimeoutMs?: number;
  headersTimeoutMs?: number;
  installSignalHandlers?: boolean;
}

export interface RunningGateway {
  url: string;
  close(): Promise<void>;
}

interface GatewayLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

/** @internal Dependency seam for request-pipeline fault tests. */
export interface StartGatewayDependencies {
  authenticator?: Authenticator;
  logger?: GatewayLogger;
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

// `content-length` is deliberately absent: the gateway forwards the bytes it actually
// streamed and Node picks the framing (chunked), so a client-declared length must not
// reach the backend and desync the request.
const EXACT_REQUEST_HEADERS = new Set([
  'content-type',
  'accept',
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
    target.port.length === 0 ||
    target.username.length > 0 ||
    target.password.length > 0 ||
    target.pathname !== '/mcp' ||
    target.search.length > 0 ||
    target.hash.length > 0
  ) {
    throw new Error('Gateway route targets must match http://<loopback>:<port>/mcp exactly');
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
    const target = configured ?? `http://127.0.0.1:${PROCESS_PORTS[route.process]}/mcp`;
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

/** @internal Exported for the access-mode tripwire unit test. */
export function addIdentityAssertion(
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
  // Phase 4 must verify this assertion against the route's AUD before forwarding it.
  throw new Error('access-mode forwarding requires Phase 4 verification');
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

export async function startGateway(
  options: StartGatewayOptions = {},
  dependencies: StartGatewayDependencies = {},
): Promise<RunningGateway> {
  const config = loadProcessConfig('gateway', options.env);
  if (config.nodeEnv === 'production') {
    if (options.listenPortOverride !== undefined) {
      throw new Error('listenPortOverride is test-only and cannot be used in production');
    }
    if (options.routeTargets !== undefined) {
      throw new Error('routeTargets is test-only and cannot be used in production');
    }
    if (options.upstreamTimeoutMs !== undefined) {
      throw new Error('upstreamTimeoutMs is test-only and cannot be used in production');
    }
    if (options.headersTimeoutMs !== undefined) {
      throw new Error('headersTimeoutMs is test-only and cannot be used in production');
    }
    if (dependencies.authenticator !== undefined || dependencies.logger !== undefined) {
      throw new Error(
        'Gateway dependency overrides are test-only and cannot be used in production',
      );
    }
  }
  const authenticator = dependencies.authenticator ?? createAuthenticator(config, 'gateway');
  const targets = buildRouteTargets(options.routeTargets);
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(upstreamTimeoutMs) || upstreamTimeoutMs <= 0) {
    throw new RangeError('upstreamTimeoutMs must be a positive finite number');
  }
  const headersTimeoutMs = options.headersTimeoutMs ?? HEADERS_TIMEOUT_MS;
  if (!Number.isFinite(headersTimeoutMs) || headersTimeoutMs <= 0) {
    throw new RangeError('headersTimeoutMs must be a positive finite number');
  }

  const logger = dependencies.logger ?? createLogger({ name: 'gateway', level: config.logLevel });
  const takeRateLimitToken = createRateLimiter(config.rateLimitPerMinute);
  let activeListenPort = options.listenPortOverride ?? config.port;
  let hosts = allowedHostnames(config.publicBaseUrl);
  let origins = allowedOrigins(config.publicBaseUrl, activeListenPort);

  const httpServer = createServer(
    {
      requestTimeout: REQUEST_TIMEOUT_MS,
      headersTimeout: headersTimeoutMs,
      keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
      connectionsCheckingInterval: Math.min(headersTimeoutMs, 1_000),
    },
    (request, response) => {
      // The gateway always owns its request ID; a client-supplied value is kept only as
      // a log field and never adopted, echoed, or forwarded.
      const requestId = newRequestId();
      const clientRequestId = validRequestId(request.headers[REQUEST_ID_HEADER]);
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
            ...(clientRequestId === undefined ? {} : { clientRequestId }),
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
        const edgeHeaders = devModeEdgeHeaders(config.authMode, request.headers);
        if (edgeHeaders.length > 0) {
          logger.warn(
            { edgeHeaders: redact(edgeHeaders), requestId },
            'edge headers rejected in dev auth mode',
          );
          rejectJson(request, response, 403, { error: 'forbidden' });
          return;
        }
        const hostname = hostnameFromHostHeader(request.headers.host);
        if (hostname === undefined || !hosts.has(hostname)) {
          rejectJson(request, response, 403, { error: 'forbidden' });
          return;
        }
        if (!originIsAllowed(request.headers.origin, origins)) {
          rejectJson(request, response, 403, { error: 'forbidden' });
          return;
        }

        if (routePath === '/healthz' && request.method === 'GET') {
          sendJson(response, 200, { status: 'ok', version: gatewayVersion });
          return;
        }

        const route = findRoute(routePath);
        if (route === undefined) {
          rejectJson(request, response, 404, { error: 'not found' });
          return;
        }
        if (request.method !== 'POST') {
          response.setHeader('allow', 'POST');
          rejectJson(request, response, 405, { error: 'method not allowed' });
          return;
        }

        if (contentLengthExceedsLimit(request.headers)) {
          rejectJson(request, response, 413, { error: 'request body too large' });
          return;
        }

        const authentication = await authenticator.authenticate(request.headers);
        if (!authentication.ok) {
          rejectJson(request, response, 401, { error: 'unauthorized' });
          return;
        }
        principalId = authentication.principal.id;

        const rateLimit = takeRateLimitToken(authentication.principal);
        if (!rateLimit.allowed) {
          response.setHeader('retry-after', rateLimit.retryAfterSeconds.toString());
          rejectJson(request, response, 429, { error: 'rate limit exceeded' });
          return;
        }

        const target = targets.get(route.process);
        if (target === undefined) {
          rejectJson(request, response, 503, { error: 'backend unavailable' });
          return;
        }
        const forwarded = requestHeadersForUpstream(request.headers, requestId);
        forwarded.host = targetHostHeader(target);
        if (!addIdentityAssertion(forwarded, request.headers, config.authMode)) {
          rejectJson(request, response, 401, { error: 'unauthorized' });
          return;
        }

        let bodyBytes = 0;
        let bodyTooLarge = false;
        let clientDisconnected = false;
        let upstreamTimedOut = false;
        let upstreamSettled = false;
        let deferredFailure = false;
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

        // Once the upstream has failed or answered, further client body bytes are
        // counted and discarded, never written or stored, so the byte-count decision
        // (413 vs the deferred upstream outcome) stays the gateway's own.
        const discardRemainingBody = (): void => {
          upstreamSettled = true;
          request.resume();
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
              // The upstream answered while the client body was still arriving:
              // hold the response, stop writing upstream, and keep counting the
              // body so an over-limit request still answers 413 deterministically.
              pendingUpstreamResponse = upstreamResponse;
              upstreamResponse.pause();
              discardRemainingBody();
              return;
            }
            forwardUpstreamResponse(upstreamResponse);
          },
        );

        const timeout = setTimeout(() => {
          if (upstreamTimedOut || bodyTooLarge || clientDisconnected) {
            return;
          }
          if (upstreamSettled && !requestBodyComplete) {
            // The upstream failed or answered, but the client never finished the
            // body it promised. Stop waiting; the body limit no longer applies.
            upstreamTimedOut = true;
            pendingUpstreamResponse?.destroy();
            if (response.headersSent) {
              response.destroy();
            } else if (deferredFailure) {
              rejectJson(request, response, 503, { error: 'backend unavailable' });
            } else {
              rejectJson(request, response, 504, { error: 'upstream timeout' });
            }
            return;
          }
          upstreamTimedOut = true;
          upstreamRequest.destroy();
          pendingUpstreamResponse?.destroy();
          if (response.headersSent) {
            response.destroy();
          } else {
            rejectJson(request, response, 504, { error: 'upstream timeout' });
          }
        }, upstreamTimeoutMs);
        timeout.unref();

        upstreamRequest.once('error', () => {
          if (bodyTooLarge || clientDisconnected || upstreamTimedOut) {
            return;
          }
          if (requestBodyComplete) {
            clearTimeout(timeout);
            upstreamSettled = true;
            if (response.headersSent) {
              response.destroy();
            } else {
              rejectJson(request, response, 503, { error: 'backend unavailable' });
            }
            return;
          }
          // The upstream died while the client was still sending the body. Defer the
          // outcome until the body completes: an over-limit body must answer 413 no
          // matter when the backend gave up. An already-received response survives
          // and is forwarded once the body completes within the limit.
          deferredFailure = true;
          discardRemainingBody();
        });

        let waitingForUpstreamDrain = false;
        const resumeDownstream = () => {
          waitingForUpstreamDrain = false;
          request.resume();
        };
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
          if (bodyTooLarge || clientDisconnected || upstreamTimedOut) {
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
              rejectJson(request, response, 413, { error: 'request body too large' });
            }
            return;
          }
          if (upstreamSettled) {
            // The upstream already failed or answered: discard the remainder of the
            // body (counted above, never stored) until it completes.
            return;
          }
          if (!upstreamRequest.write(buffer)) {
            // At most one pending drain listener at a time; a fresh once('drain')
            // per backpressured chunk would pile up listeners until Node warns.
            request.pause();
            if (!waitingForUpstreamDrain) {
              waitingForUpstreamDrain = true;
              upstreamRequest.once('drain', resumeDownstream);
            }
          }
        });
        request.once('end', () => {
          requestBodyComplete = true;
          if (bodyTooLarge || clientDisconnected || upstreamTimedOut) {
            return;
          }
          if (pendingUpstreamResponse !== undefined) {
            // The upstream answered before the body completed, and the body stayed
            // within the limit: forward the held response now.
            const upstreamResponse = pendingUpstreamResponse;
            pendingUpstreamResponse = undefined;
            forwardUpstreamResponse(upstreamResponse);
            upstreamResponse.resume();
            return;
          }
          if (deferredFailure) {
            clearTimeout(timeout);
            upstreamSettled = true;
            rejectJson(request, response, 503, { error: 'backend unavailable' });
            return;
          }
          upstreamRequest.end();
        });
        request.once('error', abortUpstream);
      })().catch((error: unknown) => {
        logger.error({ error: redact(error), requestId }, 'unexpected request pipeline error');
        if (response.headersSent) {
          response.destroy();
        } else {
          rejectJson(request, response, 500, { error: 'internal server error' });
        }
      });
    },
  );

  const lifecycle = createHttpLifecycle(httpServer, { drainMs: SHUTDOWN_DRAIN_MS });
  const logShutdownFailure = (error: unknown) => {
    logger.error({ error: redact(error) }, 'gateway shutdown failed');
    process.exitCode = 1;
  };
  const signalHandler = () => {
    void lifecycle.shutdown().catch(logShutdownFailure);
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
    await lifecycle.shutdown().catch(logShutdownFailure);
    throw error;
  }

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
