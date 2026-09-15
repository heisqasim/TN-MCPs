import { scrubKnownSecrets } from './known-secrets.js';

export const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  /token/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /api[_-]?key/i,
  /authorization/i,
  /cookie/i,
  /private[_-]?key/i,
  /client[_-]?secret/i,
  /credential/i,
  /session/i,
  /assertion/i,
];

const AUTHORIZATION_VALUE_PATTERN = /\b(?:Bearer|Basic)\s+\S+/gi;
const JWT_VALUE_PATTERN = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g;

export const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
  AUTHORIZATION_VALUE_PATTERN,
  /\b(?:cfut_|cfat_|cfast_)[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{36,}|\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-proj-[A-Za-z0-9_-]{20,}/g,
  JWT_VALUE_PATTERN,
];

export interface RedactOptions {
  maxDepth?: number;
  includeStack?: boolean;
}

const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';
const TRUNCATED = '[Truncated]';
const FUNCTION = '[Function]';

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function redactString(value: string): string {
  let result = scrubKnownSecrets(value);
  for (const pattern of SECRET_VALUE_PATTERNS) {
    result = result.replace(pattern, (match: string) => {
      if (pattern === JWT_VALUE_PATTERN && match.length < 60) {
        return match;
      }
      if (pattern === AUTHORIZATION_VALUE_PATTERN) {
        return `${match.slice(0, match.search(/\s/))} ${REDACTED}`;
      }
      return REDACTED;
    });
  }
  return result;
}

function defineEntry(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function binaryDescription(byteLength: number): string {
  return `[Binary ${byteLength} bytes]`;
}

function redactUrl(value: URL): string {
  const safeUrl = new URL(value.href);
  safeUrl.username = '';
  safeUrl.password = '';

  const safeParameters = new URLSearchParams();
  for (const [key, parameterValue] of safeUrl.searchParams) {
    safeParameters.append(key, isSecretKey(key) ? REDACTED : redactString(parameterValue));
  }
  safeUrl.search = safeParameters.toString();
  return redactString(safeUrl.href);
}

export function redact(value: unknown, opts: RedactOptions = {}): unknown {
  const maxDepth = opts.maxDepth ?? 8;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new RangeError('maxDepth must be a non-negative integer');
  }

  const ancestors = new WeakSet<object>();

  function visitEntries(entries: Iterable<readonly [string, unknown]>, depth: number) {
    const clone: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      defineEntry(clone, key, isSecretKey(key) ? REDACTED : visit(item, depth + 1));
    }
    return clone;
  }

  function visitObject(current: object, depth: number): unknown {
    if (ancestors.has(current)) {
      return CIRCULAR;
    }

    if (depth > maxDepth) {
      return TRUNCATED;
    }

    if (current instanceof Date) {
      return Number.isNaN(current.getTime()) ? 'Invalid Date' : current.toISOString();
    }

    if (current instanceof URL) {
      return redactUrl(current);
    }

    if (current instanceof ArrayBuffer || ArrayBuffer.isView(current)) {
      return binaryDescription(current.byteLength);
    }

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        return current.map((item) => visit(item, depth + 1));
      }

      if (current instanceof Map) {
        const entries = [...current].map(([key, item]) => [String(key), item] as const);
        return visitEntries(entries, depth);
      }

      if (current instanceof Set) {
        return [...current].map((item) => visit(item, depth + 1));
      }

      if (current instanceof Error) {
        const normalized: Record<string, unknown> = {};
        defineEntry(normalized, 'name', redactString(current.name));
        defineEntry(normalized, 'message', redactString(current.message));

        for (const [key, item] of Object.entries(current)) {
          if (key !== 'name' && key !== 'message' && key !== 'cause' && key !== 'stack') {
            defineEntry(normalized, key, isSecretKey(key) ? REDACTED : visit(item, depth + 1));
          }
        }

        if ('cause' in current) {
          defineEntry(normalized, 'cause', visit(current.cause, depth + 1));
        }
        if (opts.includeStack && current.stack !== undefined) {
          defineEntry(normalized, 'stack', redactString(current.stack));
        }
        return normalized;
      }

      return visitEntries(Object.entries(current), depth);
    } finally {
      ancestors.delete(current);
    }
  }

  function visit(current: unknown, depth: number): unknown {
    if (typeof current === 'string') {
      return redactString(current);
    }
    if (typeof current === 'bigint') {
      return current.toString(10);
    }
    if (typeof current === 'symbol') {
      return redactString(current.description ?? '');
    }
    if (typeof current === 'function') {
      return FUNCTION;
    }
    if (typeof current !== 'object' || current === null) {
      return current;
    }
    return visitObject(current, depth);
  }

  return visit(value, 0);
}
