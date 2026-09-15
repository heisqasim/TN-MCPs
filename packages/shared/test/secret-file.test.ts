import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { scrubKnownSecrets } from '../src/known-secrets.js';
import { readSecretFile, SecretFileError } from '../src/secret-file.js';

const temporaryDirectories: string[] = [];

function fixture(content = 'development-value', mode = 0o600): string {
  const directory = mkdtempSync(join(tmpdir(), 'tn-mcps-secret-file-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'secret');
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, mode);
  return path;
}

function ownerUid(): number {
  if (process.getuid === undefined) {
    throw new Error('This test requires POSIX file ownership');
  }
  return process.getuid();
}

function groupGid(): number {
  if (process.getgid === undefined) {
    throw new Error('This test requires POSIX file groups');
  }
  return process.getgid();
}

function read(
  path: string,
  overrides: { allowedOwnerUids?: number[]; allowedGroupGid?: number } = {},
) {
  return readSecretFile(path, {
    variable: 'TN_DEV_TOKEN_FILE',
    allowedOwnerUids: overrides.allowedOwnerUids ?? [ownerUid()],
    ...(overrides.allowedGroupGid === undefined
      ? {}
      : { allowedGroupGid: overrides.allowedGroupGid }),
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('readSecretFile', () => {
  it('reads a mode 0600 regular file', () => {
    expect(read(fixture('value', 0o600))).toBe('value');
  });

  it('returns content read through the checked file descriptor', () => {
    const expected = 'content-from-the-open-file';

    expect(read(fixture(expected, 0o600))).toBe(expected);
  });

  it('registers every value it returns in the known-secret registry', () => {
    const expected = 'read-then-scrubbed-value';

    expect(read(fixture(expected, 0o600))).toBe(expected);
    expect(scrubKnownSecrets(`output ${expected} tail`)).toBe('output [REDACTED] tail');
  });

  it('allows mode 0640 only for the matching group', () => {
    const path = fixture('group-value', 0o640);

    expect(read(path, { allowedGroupGid: groupGid() })).toBe('group-value');
    expect(() => read(path)).toThrowError(/unapproved group/);
    expect(() => read(path, { allowedGroupGid: groupGid() + 1 })).toThrowError(/unapproved group/);
  });

  it.each([
    [0o644, 'readable by others'],
    [0o604, 'readable by others'],
    [0o602, 'writable by others'],
    [0o601, 'executable by others'],
    [0o660, 'writable by its group'],
  ])('rejects mode %s', (mode, rule) => {
    expect(() => read(fixture('value', mode))).toThrowError(rule);
  });

  it('rejects a symlink to a valid file', () => {
    const target = fixture('value', 0o600);
    const link = join(target, '..', 'secret-link');
    symlinkSync(target, link);

    expect(() => read(link)).toThrowError(/symbolic link/);
  });

  it('rejects a non-regular file', () => {
    const file = fixture();
    const directory = join(file, '..', 'nested');
    mkdirSync(directory);

    expect(() => read(directory)).toThrowError(/not a regular file/);
  });

  it('rejects an owner outside the allowlist', () => {
    expect(() => read(fixture(), { allowedOwnerUids: [ownerUid() + 1] })).toThrowError(/owner uid/);
  });

  it('names the variable when the file is missing', () => {
    const path = join(fixture(), '..', 'missing');

    expect(() => read(path)).toThrowError(SecretFileError);
    expect(() => read(path)).toThrowError(/TN_DEV_TOKEN_FILE/);
  });

  it('rejects a file that cannot be read', () => {
    const path = fixture('value', 0o000);

    expect(() => read(path)).toThrowError(/TN_DEV_TOKEN_FILE: cannot inspect file/);
  });

  it('rejects a file over the size cap without exposing its content', () => {
    const tokenLookingContent = ['gh', 'p_', 'B'.repeat(36)].join('');
    const path = fixture(`${tokenLookingContent}${'x'.repeat(65_537)}`);

    try {
      read(path);
      throw new Error('Expected readSecretFile to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SecretFileError);
      expect(String(error)).toContain('TN_DEV_TOKEN_FILE: file is too large');
      expect(String(error)).not.toContain(tokenLookingContent);
    }
  });

  it('trims exactly one LF or CRLF', () => {
    expect(read(fixture('one\n'))).toBe('one');
    expect(read(fixture('two\r\n'))).toBe('two');
    expect(read(fixture('three\n\n'))).toBe('three\n');
  });

  it.each(['', '\n', '\r\n'])('rejects empty content after trimming', (content) => {
    expect(() => read(fixture(content))).toThrowError(/file is empty/);
  });

  it('never includes file content in an error', () => {
    const tokenLookingContent = ['gh', 'p_', 'A'.repeat(36)].join('');
    const path = fixture(tokenLookingContent, 0o644);

    try {
      read(path);
      throw new Error('Expected readSecretFile to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SecretFileError);
      expect(String(error)).toContain('TN_DEV_TOKEN_FILE');
      expect(String(error)).not.toContain(tokenLookingContent);
    }
  });
});
