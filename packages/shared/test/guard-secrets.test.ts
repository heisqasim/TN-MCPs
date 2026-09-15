import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const guardPath = fileURLToPath(new URL('../../../scripts/guard-secrets.mjs', import.meta.url));
const temporaryDirectories: string[] = [];

function createRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tn-mcps-guard-'));
  temporaryDirectories.push(directory);
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  return directory;
}

function runGuard(directory: string) {
  return spawnSync(process.execPath, [guardPath, directory], {
    cwd: dirname(guardPath),
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('guard-secrets', () => {
  it('reports rules and locations without printing secret text', () => {
    const directory = createRepository();
    const fakeToken = ['gh', 'p_', 'A'.repeat(36)].join('');
    writeFileSync(join(directory, 'credentials.txt'), `token=${fakeToken}\n`);
    writeFileSync(join(directory, 'settings.env'), `GH_TOKEN=${fakeToken}\n`);

    const result = runGuard(directory);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('credentials.txt:1: github-token');
    expect(output).toContain('settings.env:1: env-assignment');
    expect(output).not.toContain(fakeToken);
  });

  it('passes a clean tree', () => {
    const directory = createRepository();
    writeFileSync(join(directory, 'app.txt'), 'nothing sensitive here\n');

    const result = runGuard(directory);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Secret guard passed.');
  });

  it('does not report an ignored env file', () => {
    const directory = createRepository();
    const fakeToken = ['gh', 'p_', 'B'.repeat(36)].join('');
    writeFileSync(join(directory, '.gitignore'), '.env\n');
    writeFileSync(join(directory, '.env'), `GITHUB_TOKEN=${fakeToken}\n`);

    const result = runGuard(directory);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).not.toContain('.env');
    expect(output).not.toContain(fakeToken);
  });

  it('skips tracked files deleted from the working tree', () => {
    const directory = createRepository();
    const deletedPath = join(directory, 'deleted.txt');
    writeFileSync(deletedPath, 'tracked and then deleted\n');
    execFileSync('git', ['add', 'deleted.txt'], { cwd: directory });
    rmSync(deletedPath);

    const result = runGuard(directory);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Secret guard passed.');
  });
});
