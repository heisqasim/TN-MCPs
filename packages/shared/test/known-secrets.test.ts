import { describe, expect, it } from 'vitest';

import { registerSecretValue, scrubKnownSecrets } from '../src/known-secrets.js';

describe('known-secret registry', () => {
  it('ignores values shorter than 8 characters', () => {
    registerSecretValue('short');
    registerSecretValue('seven77');

    expect(scrubKnownSecrets('short and seven77 stay untouched')).toBe(
      'short and seven77 stay untouched',
    );
  });

  it('replaces registered values of at least 8 characters', () => {
    const secret = 'registered-secret-value';

    registerSecretValue(secret);

    expect(scrubKnownSecrets(`before ${secret} after`)).toBe('before [REDACTED] after');
    expect(scrubKnownSecrets(secret)).toBe('[REDACTED]');
  });

  it('replaces every occurrence of every registered value, longest first', () => {
    const long = 'aaaa-bbbb-cccc-dddd';
    const short = 'bbbb-cccc';

    registerSecretValue(long);
    registerSecretValue(short);

    expect(scrubKnownSecrets(`${long} ${short} ${short}`)).toBe('[REDACTED] [REDACTED] [REDACTED]');
  });
});
