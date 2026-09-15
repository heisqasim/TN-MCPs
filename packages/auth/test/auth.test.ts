import type { IncomingHttpHeaders } from 'node:http';
import type { ProcessConfig } from '@tn-mcps/config';
import { describe, expect, it } from 'vitest';

import {
  createAuthenticator,
  DEV_ASSERTION_HEADER,
  DevTokenAuthenticator,
  type DevTokenAuthenticatorOptions,
} from '../src/index.js';

const developmentToken = ['local', 'development', 'credential'].join('-');

function authenticator(source: DevTokenAuthenticatorOptions['source']) {
  return new DevTokenAuthenticator({ token: developmentToken, source });
}

function validHeaders(source: DevTokenAuthenticatorOptions['source']): IncomingHttpHeaders {
  return source === 'authorization'
    ? { authorization: `Bearer ${developmentToken}` }
    : { [DEV_ASSERTION_HEADER]: developmentToken };
}

describe.each(['authorization', 'dev-assertion'] as const)(
  'DevTokenAuthenticator with %s source',
  (source) => {
    it('accepts the valid token with the default principal', async () => {
      await expect(authenticator(source).authenticate(validHeaders(source))).resolves.toEqual({
        ok: true,
        principal: {
          kind: 'dev',
          id: 'dev',
          scopes: ['tn:read', 'cloudflare:read'],
        },
      });
    });

    it('rejects a missing header', async () => {
      await expect(authenticator(source).authenticate({})).resolves.toEqual({
        ok: false,
        status: 401,
        reason: 'missing credentials',
      });
    });

    it('rejects an invalid token without exposing it in the reason', async () => {
      const invalidToken = ['wrong', 'development', 'credential'].join('-');
      const headers =
        source === 'authorization'
          ? { authorization: `Bearer ${invalidToken}` }
          : { [DEV_ASSERTION_HEADER]: invalidToken };
      const result = await authenticator(source).authenticate(headers);

      expect(result).toEqual({ ok: false, status: 401, reason: 'invalid credentials' });
      if (!result.ok) {
        expect(result.reason).not.toContain(invalidToken);
        expect(result.reason).not.toContain(developmentToken);
      }
    });

    it('rejects multiple header values', async () => {
      const headers =
        source === 'authorization'
          ? { authorization: [`Bearer ${developmentToken}`, `Bearer ${developmentToken}`] }
          : { [DEV_ASSERTION_HEADER]: [developmentToken, developmentToken] };

      await expect(authenticator(source).authenticate(headers)).resolves.toMatchObject({
        ok: false,
        status: 401,
      });
    });

    it('rejects a credential of a different length', async () => {
      const shortCredential = 'short';
      const headers =
        source === 'authorization'
          ? { authorization: `Bearer ${shortCredential}` }
          : { [DEV_ASSERTION_HEADER]: shortCredential };

      await expect(authenticator(source).authenticate(headers)).resolves.toEqual({
        ok: false,
        status: 401,
        reason: 'invalid credentials',
      });
    });
  },
);

describe('DevTokenAuthenticator options', () => {
  it('uses explicitly supplied scopes', async () => {
    const instance = new DevTokenAuthenticator({
      token: developmentToken,
      source: 'dev-assertion',
      scopes: ['tn:read'],
    });

    await expect(instance.authenticate(validHeaders('dev-assertion'))).resolves.toMatchObject({
      ok: true,
      principal: { scopes: ['tn:read'] },
    });
  });

  it('rejects malformed bearer credentials', async () => {
    await expect(
      authenticator('authorization').authenticate({ authorization: developmentToken }),
    ).resolves.toEqual({ ok: false, status: 401, reason: 'invalid credentials' });
  });
});

describe('createAuthenticator', () => {
  const baseConfig: ProcessConfig = {
    process: 'gateway',
    nodeEnv: 'production',
    logLevel: 'info',
    bindHost: '127.0.0.1',
    port: 8790,
    authMode: 'access',
    rateLimitPerMinute: 120,
  };

  it('fails closed in access mode', () => {
    expect(() => createAuthenticator(baseConfig, 'gateway')).toThrowError(
      'TN_AUTH_MODE=access is implemented in Phase 4 (Cloudflare Access verification)',
    );
  });

  it.each([
    ['gateway', 'authorization'],
    ['backend', 'dev-assertion'],
  ] as const)('loads the dev secret and selects the %s role source', async (role, source) => {
    const config: ProcessConfig = {
      ...baseConfig,
      nodeEnv: 'development',
      authMode: 'dev',
      devTokenFile: '/run/tn-mcps/development-token',
    };
    const instance = createAuthenticator(config, role, {
      getuid: () => 1234,
      readSecretFile: (path, options) => {
        expect(path).toBe('/run/tn-mcps/development-token');
        expect(options).toEqual({
          variable: 'TN_DEV_TOKEN_FILE',
          allowedOwnerUids: [1234],
        });
        return developmentToken;
      },
    });

    await expect(instance.authenticate(validHeaders(source))).resolves.toMatchObject({ ok: true });
  });
});
