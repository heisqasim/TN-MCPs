import { loadConfig } from '@tn-mcps/shared';
import { z } from 'zod';

export const PROCESS_PORTS = {
  gateway: 8790,
  cloudflare: 8701,
  github: 8702,
  oracle: 8703,
  telos: 8704,
} as const;

export type ProcessName = keyof typeof PROCESS_PORTS;

export interface Route {
  readonly path: '/cloudflare/mcp' | '/github/mcp' | '/oracle/mcp' | '/telos/mcp';
  readonly process: Exclude<ProcessName, 'gateway'>;
}

export const ROUTES = [
  { path: '/cloudflare/mcp', process: 'cloudflare' },
  { path: '/github/mcp', process: 'github' },
  { path: '/oracle/mcp', process: 'oracle' },
  { path: '/telos/mcp', process: 'telos' },
] as const satisfies readonly Route[];

export const MAX_BODY_BYTES = 1_048_576;
export const REQUEST_TIMEOUT_MS = 30_000;
export const HEADERS_TIMEOUT_MS = 10_000;
export const KEEP_ALIVE_TIMEOUT_MS = 5_000;
export const SHUTDOWN_DRAIN_MS = 25_000;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

// Cloudflare Tunnel always adds edge headers. Refusing them in dev mode prevents a
// loopback-only development authenticator from becoming reachable through a tunnel.
export const EDGE_HEADERS = Object.freeze([
  'cf-ray',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cdn-loop',
  'cf-visitor',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
  'x-real-ip',
  'cf-access-jwt-assertion',
] as const);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function urlHostname(url: URL): string {
  return url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

const logLevelSchema = z
  .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  .default('info');

const publicBaseUrlSchema = z.string().superRefine((value, context) => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      context.addIssue({ code: 'custom', message: 'must be an absolute HTTP(S) URL' });
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'must be an absolute HTTP(S) URL' });
  }
});

function processConfigSchema(processName: ProcessName) {
  return z
    .object({
      NODE_ENV: z.enum(['development', 'test', 'production']),
      TN_LOG_LEVEL: logLevelSchema,
      TN_BIND_HOST: z
        .string()
        .default('127.0.0.1')
        .refine(isLoopbackHost, 'must be a loopback host'),
      TN_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
      TN_AUTH_MODE: z.enum(['access', 'dev']),
      TN_DEV_TOKEN_FILE: z.string().min(1, 'must not be empty').optional(),
      TN_PUBLIC_BASE_URL: publicBaseUrlSchema.optional(),
      TN_RATE_LIMIT_PER_MINUTE: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_RATE_LIMIT_PER_MINUTE),
    })
    .superRefine((config, context) => {
      if (config.TN_AUTH_MODE !== 'dev') {
        return;
      }

      if (config.NODE_ENV !== 'development') {
        const message = 'TN_AUTH_MODE requires NODE_ENV to select local development';
        context.addIssue({ code: 'custom', path: ['TN_AUTH_MODE'], message });
        context.addIssue({ code: 'custom', path: ['NODE_ENV'], message });
      }

      if (config.TN_DEV_TOKEN_FILE === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['TN_DEV_TOKEN_FILE'],
          message: 'is required for the selected TN_AUTH_MODE',
        });
      }

      if (config.TN_PUBLIC_BASE_URL !== undefined) {
        let publicUrl: URL | undefined;
        try {
          publicUrl = new URL(config.TN_PUBLIC_BASE_URL);
        } catch {
          return;
        }
        if (!isLoopbackHost(urlHostname(publicUrl))) {
          const message = 'TN_AUTH_MODE requires TN_PUBLIC_BASE_URL to use a loopback host';
          context.addIssue({ code: 'custom', path: ['TN_AUTH_MODE'], message });
          context.addIssue({ code: 'custom', path: ['TN_PUBLIC_BASE_URL'], message });
        }
      }
    })
    .transform((config) => ({
      ...config,
      TN_PORT: config.TN_PORT ?? PROCESS_PORTS[processName],
    }));
}

export type NodeEnvironment = 'development' | 'test' | 'production';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
export type AuthMode = 'access' | 'dev';

export function devModeEdgeHeaders(
  authMode: AuthMode,
  headers: Readonly<Record<string, unknown>>,
): readonly string[] {
  if (authMode !== 'dev') {
    return [];
  }
  return EDGE_HEADERS.filter((header) => Object.hasOwn(headers, header));
}

export interface ProcessConfig {
  readonly process: ProcessName;
  readonly nodeEnv: NodeEnvironment;
  readonly logLevel: LogLevel;
  readonly bindHost: string;
  readonly port: number;
  readonly authMode: AuthMode;
  readonly devTokenFile?: string;
  readonly publicBaseUrl?: string;
  readonly rateLimitPerMinute: number;
}

export function loadProcessConfig(
  processName: ProcessName,
  env: Record<string, string | undefined> = process.env,
): Readonly<ProcessConfig> {
  const parsed = loadConfig(processConfigSchema(processName), env);
  const config: ProcessConfig = {
    process: processName,
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.TN_LOG_LEVEL,
    bindHost: parsed.TN_BIND_HOST,
    port: parsed.TN_PORT,
    authMode: parsed.TN_AUTH_MODE,
    rateLimitPerMinute: parsed.TN_RATE_LIMIT_PER_MINUTE,
    ...(parsed.TN_DEV_TOKEN_FILE === undefined ? {} : { devTokenFile: parsed.TN_DEV_TOKEN_FILE }),
    ...(parsed.TN_PUBLIC_BASE_URL === undefined
      ? {}
      : { publicBaseUrl: parsed.TN_PUBLIC_BASE_URL }),
  };
  return Object.freeze(config);
}
