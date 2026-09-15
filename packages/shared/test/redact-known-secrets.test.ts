import { describe, expect, it } from 'vitest';

import { registerSecretValue } from '../src/known-secrets.js';
import { redact } from '../src/redact.js';

describe('redact with the known-secret registry', () => {
  it('scrubs registered secret values from every string it visits', () => {
    const secret = ['dev', 'file', 'credential'].join('-');
    registerSecretValue(secret);

    expect(redact({ label: `embedded ${secret} inside`, count: 3 })).toEqual({
      label: 'embedded [REDACTED] inside',
      count: 3,
    });
    expect(redact(`plain ${secret} end`)).toBe('plain [REDACTED] end');
  });

  it('scrubs registered values inside errors without stacks', () => {
    const secret = 'upstream-secret-material';
    registerSecretValue(secret);

    const output = redact(new Error(`call failed with ${secret}`)) as Record<string, unknown>;

    expect(output).toMatchObject({ name: 'Error', message: 'call failed with [REDACTED]' });
    expect(output).not.toHaveProperty('stack');
  });
});
