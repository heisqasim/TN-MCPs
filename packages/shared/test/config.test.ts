import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ConfigError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('returns validated configuration', () => {
    const schema = z.object({ PORT: z.coerce.number().int().positive() });

    expect(loadConfig(schema, { PORT: '8080' })).toEqual({ PORT: 8080 });
  });

  it('names missing required variables', () => {
    const schema = z.object({ REQUIRED_TOKEN: z.string() });

    expect(() => loadConfig(schema, {})).toThrowError(ConfigError);

    try {
      loadConfig(schema, {});
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).variables).toEqual(['REQUIRED_TOKEN']);
      expect((error as Error).message).toContain('REQUIRED_TOKEN');
      expect((error as Error).message).toContain('expected string');
    }
  });

  it('never includes a received secret-looking value in errors', () => {
    const secretLookingValue = ['sk', '-live-', 'abc123'].join('');
    const schema = z.object({
      API_KEY: z.string().superRefine((value, context) => {
        context.addIssue({ code: 'custom', message: `Rejected value: ${value}` });
      }),
    });

    try {
      loadConfig(schema, { API_KEY: secretLookingValue });
      throw new Error('Expected loadConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain(secretLookingValue);
      expect(String(error)).not.toContain(secretLookingValue);
      expect((error as ConfigError).variables).toEqual(['API_KEY']);
    }
  });

  it('does not scrub short non-secret values from issue messages', () => {
    const schema = z.object({
      X: z.string().superRefine((_value, context) => {
        context.addIssue({ code: 'custom', message: 'Expected 1 item' });
      }),
    });

    expect(() => loadConfig(schema, { X: '1' })).toThrowError('Expected 1 item');
  });
});
