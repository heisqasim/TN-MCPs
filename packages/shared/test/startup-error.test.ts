import { describe, expect, it } from 'vitest';

import { registerSecretValue } from '../src/known-secrets.js';
import { formatStartupError } from '../src/startup-error.js';

describe('formatStartupError', () => {
  it('returns one JSON line with the error message', () => {
    const output = formatStartupError(new Error('configuration is invalid'), {});

    expect(output).toBe(JSON.stringify({ error: 'configuration is invalid' }));
    expect(output.split('\n')).toHaveLength(1);
  });

  it('redacts non-Error values with the unknown-startup message', () => {
    expect(formatStartupError('a string failure', {})).toBe(
      JSON.stringify({ error: 'Unknown startup error' }),
    );
    expect(formatStartupError(undefined, {})).toBe(
      JSON.stringify({ error: 'Unknown startup error' }),
    );
  });

  it('scrubs environment values of at least 4 characters, longest first', () => {
    const output = formatStartupError(new Error('failed for verylongenvsecret and envsecret'), {
      LONG_VARIABLE: 'verylongenvsecret',
      SHORT_VARIABLE: 'envsecret',
      TINY: 'abc',
    });

    const parsed = JSON.parse(output) as { error: string };
    expect(parsed.error).toBe('failed for [REDACTED] and [REDACTED]');
    expect(output).not.toContain('verylongenvsecret');
    expect(output).not.toContain('envsecret');
  });

  it('keeps environment values shorter than 4 characters', () => {
    const output = formatStartupError(new Error('value abc untouched'), { TINY: 'abc' });

    expect(output).toBe(JSON.stringify({ error: 'value abc untouched' }));
  });

  it('scrubs values registered in the known-secret registry', () => {
    const secret = 'registry-startup-secret';
    registerSecretValue(secret);

    const output = formatStartupError(new Error(`cannot read ${secret}`), {});

    expect(output).toBe(JSON.stringify({ error: 'cannot read [REDACTED]' }));
  });

  it('never includes stack traces or cause chains', () => {
    const output = formatStartupError(
      new Error('surface failure', { cause: new Error('internal cause detail') }),
      {},
    );

    expect(output).not.toContain('internal cause detail');
    expect(output).not.toContain(' at ');
    expect(output.split('\n')).toHaveLength(1);
  });
});
