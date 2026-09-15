import { describe, expect, it } from 'vitest';

import { registerSecretValue, scrubKnownSecrets } from '../src/known-secrets.js';

describe('known-secret registry cap', () => {
  it('throws at registration when a 65th distinct secret is registered', () => {
    for (let index = 0; index < 64; index += 1) {
      registerSecretValue(`cap-filler-${index.toString().padStart(2, '0')}-value`);
    }

    expect(() => registerSecretValue('cap-filler-65th-value')).toThrow(
      /known-secret registry overflow/,
    );
  });

  it('still scrubs the values held when the cap is reached', () => {
    expect(scrubKnownSecrets('head cap-filler-42-value tail')).toBe('head [REDACTED] tail');
  });
});
