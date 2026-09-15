import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from 'node:fs';

import { registerSecretValue } from './known-secrets.js';

const MAX_SECRET_FILE_BYTES = 65_536;
const SYMLINK_OPEN_ERROR_CODES = new Set(['ELOOP', 'EMLINK', 'EFTYPE']);

export interface ReadSecretFileOptions {
  variable: string;
  allowedOwnerUids: number[];
  allowedGroupGid?: number;
}

export class SecretFileError extends Error {
  readonly variable: string;
  readonly path: string;

  constructor(variable: string, path: string, rule: string, options?: ErrorOptions) {
    super(`${variable}: ${rule}`, options);
    this.name = 'SecretFileError';
    this.variable = variable;
    this.path = path;
  }
}

function formatMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, '0');
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

function readBounded(descriptor: number): Buffer {
  const buffer = Buffer.allocUnsafe(MAX_SECRET_FILE_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, null);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

export function readSecretFile(path: string, opts: ReadSecretFileOptions): string {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    if (SYMLINK_OPEN_ERROR_CODES.has(errorCode(cause) ?? '')) {
      throw new SecretFileError(opts.variable, path, `path is a symbolic link: ${path}`, {
        cause,
      });
    }
    throw new SecretFileError(opts.variable, path, `cannot inspect file ${path}`, { cause });
  }

  try {
    let metadata: Stats;
    try {
      metadata = fstatSync(descriptor);
    } catch (cause) {
      throw new SecretFileError(opts.variable, path, `cannot inspect file ${path}`, { cause });
    }

    if (!metadata.isFile()) {
      throw new SecretFileError(opts.variable, path, `path is not a regular file: ${path}`);
    }
    if (!opts.allowedOwnerUids.includes(metadata.uid)) {
      throw new SecretFileError(
        opts.variable,
        path,
        `file owner uid ${metadata.uid} is not allowed: ${path}`,
      );
    }

    const mode = metadata.mode & 0o777;
    const displayedMode = formatMode(mode);
    if ((mode & 0o004) !== 0) {
      throw new SecretFileError(
        opts.variable,
        path,
        `file is readable by others (mode ${displayedMode})`,
      );
    }
    if ((mode & 0o002) !== 0) {
      throw new SecretFileError(
        opts.variable,
        path,
        `file is writable by others (mode ${displayedMode})`,
      );
    }
    if ((mode & 0o001) !== 0) {
      throw new SecretFileError(
        opts.variable,
        path,
        `file is executable by others (mode ${displayedMode})`,
      );
    }
    if ((mode & 0o020) !== 0) {
      throw new SecretFileError(
        opts.variable,
        path,
        `file is writable by its group (mode ${displayedMode})`,
      );
    }
    if (
      (mode & 0o040) !== 0 &&
      (opts.allowedGroupGid === undefined || metadata.gid !== opts.allowedGroupGid)
    ) {
      throw new SecretFileError(
        opts.variable,
        path,
        `file is readable by an unapproved group gid ${metadata.gid} (mode ${displayedMode})`,
      );
    }
    if (metadata.size > MAX_SECRET_FILE_BYTES) {
      throw new SecretFileError(opts.variable, path, `file is too large: ${path}`);
    }

    let contentBuffer: Buffer;
    try {
      contentBuffer = readBounded(descriptor);
    } catch (cause) {
      throw new SecretFileError(opts.variable, path, `cannot read file ${path}`, { cause });
    }
    if (contentBuffer.byteLength > MAX_SECRET_FILE_BYTES) {
      throw new SecretFileError(opts.variable, path, `file is too large: ${path}`);
    }

    const content = contentBuffer.toString('utf8');
    const trimmed = content.replace(/\r?\n$/, '');
    if (trimmed.length === 0) {
      throw new SecretFileError(opts.variable, path, `file is empty: ${path}`);
    }
    registerSecretValue(trimmed);
    return trimmed;
  } finally {
    closeSync(descriptor);
  }
}
