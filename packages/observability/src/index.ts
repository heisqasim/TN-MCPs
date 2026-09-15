import { randomUUID } from 'node:crypto';

import { redact } from '@tn-mcps/shared';
import pino, { type DestinationStream, type LevelWithSilent, type Logger } from 'pino';

export interface CreateLoggerOptions {
  name: string;
  level: LevelWithSilent;
  destination?: DestinationStream;
}

function redactLogObject(object: Record<string, unknown>): Record<string, unknown> {
  return redact(object) as Record<string, unknown>;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const destination = options.destination ?? pino.destination(2);
  return pino(
    {
      name: options.name,
      level: options.level,
      formatters: {
        bindings: redactLogObject,
        log: redactLogObject,
      },
      serializers: {
        err: (error: unknown) => redact(error),
      },
      hooks: {
        logMethod(arguments_, method) {
          method.apply(
            this,
            arguments_.map((argument) => redact(argument)) as Parameters<typeof method>,
          );
        },
        streamWrite(serialized) {
          const lineEnding = serialized.endsWith('\r\n')
            ? '\r\n'
            : serialized.endsWith('\n')
              ? '\n'
              : '';
          const json =
            lineEnding.length === 0 ? serialized : serialized.slice(0, -lineEnding.length);
          return `${JSON.stringify(redact(JSON.parse(json)))}${lineEnding}`;
        },
      },
    },
    destination,
  );
}

export const REQUEST_ID_HEADER = 'x-request-id';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function newRequestId(): string {
  return randomUUID();
}

/** Returns the value only when it is a syntactically valid request ID; never generates one. */
export function validRequestId(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : undefined;
}

export function acceptOrCreateRequestId(value: string | string[] | undefined): string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : newRequestId();
}
