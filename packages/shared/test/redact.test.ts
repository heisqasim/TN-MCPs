import { describe, expect, it } from 'vitest';

import { redact } from '../src/redact.js';

describe('redact', () => {
  it('redacts nested secret keys and values in arrays', () => {
    const input = {
      profile: {
        password: 'hidden',
        integrations: [{ api_key: 'hidden' }, { clientSecret: 'hidden' }],
      },
    };

    expect(redact(input)).toEqual({
      profile: {
        password: '[REDACTED]',
        integrations: [{ api_key: '[REDACTED]' }, { clientSecret: '[REDACTED]' }],
      },
    });
  });

  it('redacts bearer credentials embedded in strings', () => {
    expect(redact('Authorization used Bearer example-value')).toBe(
      'Authorization used Bearer [REDACTED]',
    );
  });

  it('replaces cycles', () => {
    const input: Record<string, unknown> = { name: 'root' };
    input.self = input;

    expect(redact(input)).toEqual({ name: 'root', self: '[Circular]' });
  });

  it('redacts shared non-cyclic references at every occurrence', () => {
    const shared = { label: 'same object', token: 'hidden' };

    expect(redact({ a: shared, b: shared })).toEqual({
      a: { label: 'same object', token: '[REDACTED]' },
      b: { label: 'same object', token: '[REDACTED]' },
    });
  });

  it('caps traversal depth', () => {
    const input = { one: { two: { three: 'value' } } };

    expect(redact(input, { maxDepth: 1 })).toEqual({ one: { two: '[Truncated]' } });
  });

  it('does not mutate its input', () => {
    const input = { nested: { token: 'hidden', label: 'kept' } };
    const snapshot = structuredClone(input);
    const output = redact(input);

    expect(input).toEqual(snapshot);
    expect(output).not.toBe(input);
    expect((output as { nested: object }).nested).not.toBe(input.nested);
  });

  it('leaves non-secret keys and values untouched', () => {
    expect(redact({ username: 'ada', enabled: true, count: 3 })).toEqual({
      username: 'ada',
      enabled: true,
      count: 3,
    });
  });

  it('normalizes and redacts errors without exposing stacks by default', () => {
    const basicCredential = ['Basic', 'encoded-provider-credential'].join(' ');
    const cause = new Error(`upstream Bearer ${['provider', 'token'].join('-')}`);
    class ProviderError extends Error {
      readonly response = { headers: { authorization: basicCredential } };
    }
    const error = new ProviderError(`request failed with ${basicCredential}`, { cause });
    error.name = 'ProviderError';

    const withoutStack = redact(error) as Record<string, unknown>;
    const withStack = redact(error, { includeStack: true }) as Record<string, unknown>;

    expect(withoutStack).toMatchObject({
      name: 'ProviderError',
      message: 'request failed with Basic [REDACTED]',
      response: { headers: { authorization: '[REDACTED]' } },
      cause: { name: 'Error', message: 'upstream Bearer [REDACTED]' },
    });
    expect(withoutStack).not.toHaveProperty('stack');
    expect(withStack).toHaveProperty('stack');
    expect(withStack.stack).not.toContain(basicCredential);
  });

  it('normalizes supported object and primitive types to JSON-safe values', () => {
    const url = new URL('https://user:password@example.com/resource');
    url.searchParams.set('api_key', 'query-secret');
    url.searchParams.set('page', '1');
    const arrayBuffer = new ArrayBuffer(4);

    class ProviderResponse {
      readonly status = 401;
      readonly credential = 'class-secret';
    }

    const input = {
      date: new Date('2026-09-15T00:00:00.000Z'),
      url,
      map: new Map<string, unknown>([
        ['api_key', 'map-secret'],
        ['visible', { value: 'kept' }],
      ]),
      set: new Set(['first', 'second']),
      buffer: Buffer.from([1, 2, 3]),
      arrayBuffer,
      typedArray: new Uint16Array(3),
      callback: () => 'unused',
      symbol: Symbol('marker'),
      bigint: 9_007_199_254_740_993n,
      instance: new ProviderResponse(),
    };

    const output = redact(input) as Record<string, unknown>;
    const redactedUrl = new URL(output.url as string);

    expect(output).toMatchObject({
      date: '2026-09-15T00:00:00.000Z',
      map: { api_key: '[REDACTED]', visible: { value: 'kept' } },
      set: ['first', 'second'],
      buffer: '[Binary 3 bytes]',
      arrayBuffer: '[Binary 4 bytes]',
      typedArray: '[Binary 6 bytes]',
      callback: '[Function]',
      symbol: 'marker',
      bigint: '9007199254740993',
      instance: { status: 401, credential: '[REDACTED]' },
    });
    expect(redactedUrl.username).toBe('');
    expect(redactedUrl.password).toBe('');
    expect(redactedUrl.searchParams.get('api_key')).toBe('[REDACTED]');
    expect(redactedUrl.searchParams.get('page')).toBe('1');
    expect(() => JSON.stringify(output)).not.toThrow();
  });

  it('redacts high-signal credential shapes wherever they appear in strings', () => {
    const cloudflareTokens = [
      ['cf', 'ut_', 'A'.repeat(20)].join(''),
      ['cf', 'at_', 'B'.repeat(20)].join(''),
      ['cf', 'ast_', 'C'.repeat(20)].join(''),
    ];
    const githubTokens = [
      ...['p', 'o', 'u', 's', 'r'].map((kind) => ['gh', `${kind}_`, 'D'.repeat(36)].join('')),
      ['github', '_pat_', 'E'.repeat(22)].join(''),
    ];
    const anthropicToken = ['sk', '-ant-', 'F'.repeat(20)].join('');
    const openAiToken = ['sk', '-proj-', 'G'.repeat(20)].join('');
    const jwt = [`eyJ${'H'.repeat(20)}`, 'I'.repeat(20), `${'J'.repeat(19)}-`].join('.');
    const pem = [
      ['-----', 'BEGIN RSA PRIVATE KEY', '-----'].join(''),
      'private material',
      ['-----', 'END RSA PRIVATE KEY', '-----'].join(''),
    ].join('\n');
    const credentials = [...cloudflareTokens, ...githubTokens, anthropicToken, openAiToken, jwt];

    for (const credential of credentials) {
      const result = redact(`before ${credential} after`);
      expect(result).toBe('before [REDACTED] after');
      expect(result).not.toContain(credential);
    }
    expect(redact(`Basic ${['encoded', 'value'].join('-')}`)).toBe('Basic [REDACTED]');
    expect(redact(`before ${pem} after`)).toBe('before [REDACTED] after');
  });
});
