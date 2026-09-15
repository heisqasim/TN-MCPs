import { describe, expect, it } from 'vitest';

import { acceptOrCreateRequestId, createLogger, newRequestId } from '../src/index.js';

function captureDestination() {
  const lines: string[] = [];
  return {
    lines,
    destination: {
      write(message: string) {
        lines.push(message);
      },
    },
  };
}

describe('createLogger', () => {
  it('redacts secret-named keys, values, and message strings', () => {
    const capture = captureDestination();
    const bearer = ['Bearer', ['provider', 'credential'].join('-')].join(' ');
    const logger = createLogger({
      name: 'test',
      level: 'info',
      destination: capture.destination,
    });

    logger.info(
      { nested: { apiKey: 'hidden' }, upstream: `sent ${bearer}` },
      `request used ${bearer}`,
    );

    const record = JSON.parse(capture.lines[0] ?? '{}') as Record<string, unknown>;
    expect(record).toMatchObject({
      nested: { apiKey: '[REDACTED]' },
      upstream: 'sent Bearer [REDACTED]',
      msg: 'request used Bearer [REDACTED]',
    });
    expect(capture.lines[0]).not.toContain(bearer);
  });

  it('serializes a redacted Error without a stack', () => {
    const capture = captureDestination();
    const credential = ['gh', 'p_', 'A'.repeat(36)].join('');
    const logger = createLogger({
      name: 'test',
      level: 'error',
      destination: capture.destination,
    });

    logger.error({ err: new Error(`provider rejected ${credential}`) });

    const record = JSON.parse(capture.lines[0] ?? '{}') as {
      err?: Record<string, unknown>;
    };
    expect(record.err).toEqual({ name: 'Error', message: 'provider rejected [REDACTED]' });
    expect(record.err).not.toHaveProperty('stack');
    expect(capture.lines[0]).not.toContain(credential);
  });

  it('redacts child logger bindings', () => {
    const capture = captureDestination();
    const logger = createLogger({
      name: 'test',
      level: 'info',
      destination: capture.destination,
    }).child({ authorization: 'not-for-output' });

    logger.info('child message');

    const record = JSON.parse(capture.lines[0] ?? '{}') as Record<string, unknown>;
    expect(record.authorization).toBe('[REDACTED]');
  });
});

describe('request IDs', () => {
  it('creates UUID request IDs', () => {
    expect(newRequestId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
  });

  it.each(['request-123', 'a.b_c', 'Z'])('accepts valid incoming ID %s', (value) => {
    expect(acceptOrCreateRequestId(value)).toBe(value);
  });

  it.each(['line\r\nbreak', 'contains space', '', 'a'.repeat(129)])(
    'replaces invalid incoming IDs',
    (value) => {
      const result = acceptOrCreateRequestId(value);
      expect(result).not.toBe(value);
      expect(result).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it('replaces array and missing inputs', () => {
    expect(acceptOrCreateRequestId(['one', 'two'])).toMatch(/^[0-9a-f-]{36}$/);
    expect(acceptOrCreateRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
