import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  devModeEdgeHeaders,
  EDGE_HEADERS,
  isLoopbackHost,
  loadProcessConfig,
  MAX_BODY_BYTES,
  PROCESS_PORTS,
  REQUEST_TIMEOUT_MS,
  ROUTES,
  SHUTDOWN_DRAIN_MS,
} from '../src/index.js';

const accessEnvironment = {
  NODE_ENV: 'production',
  TN_AUTH_MODE: 'access',
};

describe('central process configuration', () => {
  it('exports the fixed process ports, routes, and limits', () => {
    expect(PROCESS_PORTS).toEqual({
      gateway: 8790,
      cloudflare: 8701,
      github: 8702,
      oracle: 8703,
      telos: 8704,
    });
    expect(ROUTES).toEqual([
      { path: '/cloudflare/mcp', process: 'cloudflare' },
      { path: '/github/mcp', process: 'github' },
      { path: '/oracle/mcp', process: 'oracle' },
      { path: '/telos/mcp', process: 'telos' },
    ]);
    expect({ MAX_BODY_BYTES, REQUEST_TIMEOUT_MS, SHUTDOWN_DRAIN_MS }).toEqual({
      MAX_BODY_BYTES: 1_048_576,
      REQUEST_TIMEOUT_MS: 30_000,
      SHUTDOWN_DRAIN_MS: 25_000,
    });
  });

  it('loads frozen defaults', () => {
    const config = loadProcessConfig('gateway', accessEnvironment);

    expect(config).toEqual({
      process: 'gateway',
      nodeEnv: 'production',
      logLevel: 'info',
      bindHost: '127.0.0.1',
      port: 8790,
      authMode: 'access',
      rateLimitPerMinute: DEFAULT_RATE_LIMIT_PER_MINUTE,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('accepts typed overrides', () => {
    expect(
      loadProcessConfig('gateway', {
        ...accessEnvironment,
        TN_LOG_LEVEL: 'debug',
        TN_BIND_HOST: 'localhost',
        TN_PORT: '9001',
        TN_PUBLIC_BASE_URL: 'https://mcp.example.test',
        TN_RATE_LIMIT_PER_MINUTE: '30',
      }),
    ).toMatchObject({
      logLevel: 'debug',
      bindHost: 'localhost',
      port: 9001,
      publicBaseUrl: 'https://mcp.example.test',
      rateLimitPerMinute: 30,
    });
  });
});

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '::1', 'localhost', 'LOCALHOST'])('accepts %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(['0.0.0.0', '::', '192.0.2.1', 'localhost.evil.example', 'localhost.'])(
    'rejects %s',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

describe('B6 and B7 configuration boundaries', () => {
  it('rejects a non-loopback bind host', () => {
    expect(() =>
      loadProcessConfig('gateway', { ...accessEnvironment, TN_BIND_HOST: '0.0.0.0' }),
    ).toThrowError(/TN_BIND_HOST/);
  });

  it('accepts the IPv6 loopback bind host', () => {
    expect(
      loadProcessConfig('gateway', { ...accessEnvironment, TN_BIND_HOST: '::1' }).bindHost,
    ).toBe('::1');
  });

  it('rejects dev auth outside development', () => {
    expect(() =>
      loadProcessConfig('gateway', {
        NODE_ENV: 'production',
        TN_AUTH_MODE: 'dev',
        TN_DEV_TOKEN_FILE: '/tmp/development-token',
      }),
    ).toThrowError(/TN_AUTH_MODE.*NODE_ENV|NODE_ENV.*TN_AUTH_MODE/s);
  });

  it('rejects dev auth with a public URL', () => {
    expect(() =>
      loadProcessConfig('gateway', {
        NODE_ENV: 'development',
        TN_AUTH_MODE: 'dev',
        TN_DEV_TOKEN_FILE: '/tmp/development-token',
        TN_PUBLIC_BASE_URL: 'https://mcp.telosnexus.cloud',
      }),
    ).toThrowError(/TN_AUTH_MODE.*TN_PUBLIC_BASE_URL|TN_PUBLIC_BASE_URL.*TN_AUTH_MODE/s);
  });

  it.each(['http://127.0.0.1:8790', 'http://[::1]:8790', 'https://LOCALHOST:8790'])(
    'accepts dev auth at loopback URL %s',
    (publicBaseUrl) => {
      expect(
        loadProcessConfig('gateway', {
          NODE_ENV: 'development',
          TN_AUTH_MODE: 'dev',
          TN_DEV_TOKEN_FILE: '/tmp/development-token',
          TN_PUBLIC_BASE_URL: publicBaseUrl,
        }).authMode,
      ).toBe('dev');
    },
  );

  it('rejects dev auth without TN_DEV_TOKEN_FILE', () => {
    expect(() =>
      loadProcessConfig('gateway', { NODE_ENV: 'development', TN_AUTH_MODE: 'dev' }),
    ).toThrowError(/TN_DEV_TOKEN_FILE/);
  });

  it('accepts access mode configuration', () => {
    expect(loadProcessConfig('github', accessEnvironment).authMode).toBe('access');
  });

  it('never includes received values in errors', () => {
    const receivedValue = ['sk', '-proj-', 'Z'.repeat(24)].join('');

    try {
      loadProcessConfig('gateway', { ...accessEnvironment, TN_BIND_HOST: receivedValue });
      throw new Error('Expected loadProcessConfig to throw');
    } catch (error) {
      expect(String(error)).toContain('TN_BIND_HOST');
      expect(String(error)).not.toContain(receivedValue);
    }
  });
});

describe('B7 edge headers', () => {
  it('lists the headers a tunnel or edge adds to forwarded traffic', () => {
    expect(EDGE_HEADERS).toEqual([
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
    ]);
    expect(Object.isFrozen(EDGE_HEADERS)).toBe(true);
  });

  it('flags every listed edge header in dev mode', () => {
    const headers = Object.fromEntries(EDGE_HEADERS.map((header) => [header, 'edge-value']));

    expect(devModeEdgeHeaders('dev', headers)).toEqual([...EDGE_HEADERS]);
  });

  it('flags only the headers actually present', () => {
    expect(devModeEdgeHeaders('dev', { 'cf-ray': 'edge', 'x-other': 'kept' })).toEqual(['cf-ray']);
    expect(devModeEdgeHeaders('dev', {})).toEqual([]);
  });

  it('never flags edge headers in access mode (the edge is expected there)', () => {
    const headers = Object.fromEntries(EDGE_HEADERS.map((header) => [header, 'edge-value']));

    expect(devModeEdgeHeaders('access', headers)).toEqual([]);
  });
});
