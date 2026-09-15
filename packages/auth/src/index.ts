import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import type { ProcessConfig } from '@tn-mcps/config';
import { readSecretFile } from '@tn-mcps/shared';

export interface Principal {
  kind: 'human' | 'service' | 'dev';
  id: string;
  scopes: readonly string[];
}

export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403; reason: string };

export interface Authenticator {
  authenticate(headers: IncomingHttpHeaders): Promise<AuthResult>;
}

export const ACCESS_ASSERTION_HEADER = 'cf-access-jwt-assertion';
export const DEV_ASSERTION_HEADER = 'x-tn-dev-assertion';

const DEFAULT_DEV_SCOPES = Object.freeze(['tn:read', 'cloudflare:read']);

export interface DevTokenAuthenticatorOptions {
  token: string;
  source: 'authorization' | 'dev-assertion';
  scopes?: readonly string[];
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export class DevTokenAuthenticator implements Authenticator {
  readonly #tokenDigest: Buffer;
  readonly #source: 'authorization' | 'dev-assertion';
  readonly #scopes: readonly string[];

  constructor(options: DevTokenAuthenticatorOptions) {
    if (options.token.length === 0) {
      throw new Error('Development token must not be empty');
    }
    this.#tokenDigest = digest(options.token);
    this.#source = options.source;
    this.#scopes = Object.freeze([...(options.scopes ?? DEFAULT_DEV_SCOPES)]);
  }

  async authenticate(headers: IncomingHttpHeaders): Promise<AuthResult> {
    const header =
      this.#source === 'authorization' ? headers.authorization : headers[DEV_ASSERTION_HEADER];
    if (typeof header !== 'string') {
      return { ok: false, status: 401, reason: 'missing credentials' };
    }

    const credential =
      this.#source === 'authorization' ? /^Bearer ([^\s]+)$/i.exec(header)?.[1] : header;
    if (credential === undefined) {
      return { ok: false, status: 401, reason: 'invalid credentials' };
    }

    const candidateDigest = digest(credential);
    if (!timingSafeEqual(this.#tokenDigest, candidateDigest)) {
      return { ok: false, status: 401, reason: 'invalid credentials' };
    }

    return {
      ok: true,
      principal: { kind: 'dev', id: 'dev', scopes: this.#scopes },
    };
  }
}

export interface CreateAuthenticatorDependencies {
  readSecretFile?: typeof readSecretFile;
  getuid?: () => number;
}

function currentUid(): number {
  if (process.getuid === undefined) {
    throw new Error('Cannot enforce TN_DEV_TOKEN_FILE ownership on this platform');
  }
  return process.getuid();
}

export function createAuthenticator(
  config: Readonly<ProcessConfig>,
  role: 'gateway' | 'backend',
  dependencies: CreateAuthenticatorDependencies = {},
): Authenticator {
  if (config.authMode === 'access') {
    throw new Error(
      'TN_AUTH_MODE=access is implemented in Phase 4 (Cloudflare Access verification)',
    );
  }
  if (config.devTokenFile === undefined) {
    throw new Error('TN_DEV_TOKEN_FILE is required when TN_AUTH_MODE=dev');
  }

  const loadSecret = dependencies.readSecretFile ?? readSecretFile;
  const getuid = dependencies.getuid ?? currentUid;
  const token = loadSecret(config.devTokenFile, {
    variable: 'TN_DEV_TOKEN_FILE',
    allowedOwnerUids: [getuid()],
  });
  return new DevTokenAuthenticator({
    token,
    source: role === 'gateway' ? 'authorization' : 'dev-assertion',
  });
}
