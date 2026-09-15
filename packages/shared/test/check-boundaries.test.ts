import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const boundaryPath = fileURLToPath(
  new URL('../../../scripts/check-boundaries.mjs', import.meta.url),
);
const temporaryDirectories: string[] = [];
const serverModule = '@modelcontextprotocol/' + 'server';

function createRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tn-mcps-boundaries-'));
  temporaryDirectories.push(directory);
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  return directory;
}

function writeFixture(directory: string, path: string, content: string): void {
  const filePath = join(directory, path);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function runBoundary(directory: string) {
  return spawnSync(process.execPath, [boundaryPath, directory], {
    cwd: dirname(boundaryPath),
    encoding: 'utf8',
  });
}

function outputOf(result: ReturnType<typeof runBoundary>): string {
  return `${result.stdout}${result.stderr}`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('check-boundaries', () => {
  it('reports a static server SDK import with its path and line', () => {
    const directory = createRepository();
    writeFixture(
      directory,
      'mcps/x/src/a.ts',
      `const line = 1;\nimport server from '${serverModule}';\n`,
    );

    const result = runBoundary(directory);

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('mcps/x/src/a.ts:2: B1-server-sdk-import');
  });

  it.each([
    ['subpath import', `import '${serverModule}/stdio';`],
    ['dynamic import', `import('${serverModule}');`],
    ['require', `require('${serverModule}');`],
    ['export', `export * from '${serverModule}';`],
    ['node adapter', `import nodeAdapter from '@modelcontextprotocol/node';`],
  ])('reports a %s as a B1 import', (_name, source) => {
    const directory = createRepository();
    writeFixture(directory, 'mcps/x/src/a.ts', `${source}\n`);

    const result = runBoundary(directory);

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('mcps/x/src/a.ts:1: B1-server-sdk-import');
  });

  it('allows restricted imports inside packages/mcp-common', () => {
    const directory = createRepository();
    writeFixture(
      directory,
      'packages/mcp-common/src/a.ts',
      [
        `import '${serverModule}';`,
        `import '${serverModule}/stdio';`,
        `import('@modelcontextprotocol/node');`,
        `require('@modelcontextprotocol/express');`,
        `export * from '@modelcontextprotocol/hono';`,
      ].join('\n'),
    );

    const result = runBoundary(directory);

    expect(result.status).toBe(0);
    expect(outputOf(result)).toContain('Boundary check passed.');
  });

  it('allows client imports anywhere', () => {
    const directory = createRepository();
    writeFixture(
      directory,
      'mcps/x/src/a.ts',
      "import { Client } from '@modelcontextprotocol/client';\n",
    );

    const result = runBoundary(directory);

    expect(result.status).toBe(0);
    expect(outputOf(result)).toContain('Boundary check passed.');
  });

  it('reports restricted package dependencies outside mcp-common', () => {
    const directory = createRepository();
    writeFixture(
      directory,
      'mcps/x/package.json',
      `${JSON.stringify({ dependencies: { [serverModule]: '^1.0.0' } })}\n`,
    );

    const result = runBoundary(directory);

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('mcps/x/package.json:1: B1-server-sdk-dependency');
  });

  it('reports an npm-aliased restricted dependency outside mcp-common', () => {
    const directory = createRepository();
    writeFixture(
      directory,
      'mcps/x/package.json',
      `${JSON.stringify({
        dependencies: { 'mcp-server': `npm:${serverModule}@2.0.0` },
      })}\n`,
    );

    const result = runBoundary(directory);

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('mcps/x/package.json:1: B1-server-sdk-dependency');
  });

  it('allows an npm alias whose target is not a restricted module', () => {
    const directory = createRepository();
    writeFixture(
      directory,
      'mcps/x/package.json',
      `${JSON.stringify({
        dependencies: { 'mcp-client': `npm:@modelcontextprotocol/${'client'}@2.0.0` },
      })}\n`,
    );

    const result = runBoundary(directory);

    expect(result.status).toBe(0);
    expect(outputOf(result)).toContain('Boundary check passed.');
  });

  it('allows restricted package dependencies in mcp-common', () => {
    const directory = createRepository();
    writeFixture(
      directory,
      'packages/mcp-common/package.json',
      `${JSON.stringify({ dependencies: { [serverModule]: '^1.0.0' } })}\n`,
    );

    const result = runBoundary(directory);

    expect(result.status).toBe(0);
    expect(outputOf(result)).toContain('Boundary check passed.');
  });

  it.each([
    ['outside mcp-common', 'mcps/x/src/b.ts'],
    ['in another mcp-common file', 'packages/mcp-common/src/other.ts'],
  ])('reports registerTool calls %s', (_name, path) => {
    const directory = createRepository();
    writeFixture(directory, path, "server.registerTool('name', {});\n");

    const result = runBoundary(directory);

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain(`${path}:1: B2-registration-call`);
  });

  it('allows registration calls in the policy wrapper only', () => {
    const directory = createRepository();
    writeFixture(
      directory,
      'packages/mcp-common/src/policy-wrapper.ts',
      "server.registerTool('name', {});\n",
    );

    const result = runBoundary(directory);

    expect(result.status).toBe(0);
    expect(outputOf(result)).toContain('Boundary check passed.');
  });

  it.each([
    ['outside mcp-common', 'mcps/x/src/handler.ts'],
    ['in another mcp-common file', 'packages/mcp-common/src/other.ts'],
  ])('reports setRequestHandler calls %s', (_name, path) => {
    const directory = createRepository();
    writeFixture(directory, path, "server.setRequestHandler('x', () => ({}));\n");

    const result = runBoundary(directory);

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain(`${path}:1: B2-low-level-handler-call`);
  });

  it('reports setNotificationHandler calls outside the policy wrapper', () => {
    const directory = createRepository();
    writeFixture(
      directory,
      'mcps/x/src/notifications.ts',
      "server.setNotificationHandler('x', () => ({}));\n",
    );

    const result = runBoundary(directory);

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('mcps/x/src/notifications.ts:1: B2-low-level-handler-call');
  });

  it('allows low-level handler registration in the policy wrapper only', () => {
    const directory = createRepository();
    writeFixture(
      directory,
      'packages/mcp-common/src/policy-wrapper.ts',
      "server.setRequestHandler('x', () => ({}));\nserver.setNotificationHandler('y', () => ({}));\n",
    );

    const result = runBoundary(directory);

    expect(result.status).toBe(0);
    expect(outputOf(result)).toContain('Boundary check passed.');
  });

  it('does not report SDK-style .tool( calls', () => {
    const directory = createRepository();
    writeFixture(directory, 'mcps/x/src/tool-shaped.ts', "server.tool('name', () => ({}));\n");

    const result = runBoundary(directory);

    expect(result.status).toBe(0);
    expect(outputOf(result)).toContain('Boundary check passed.');
  });

  it('documents why the package.json dependency check is the authoritative B1 gate', () => {
    const source = readFileSync(boundaryPath, 'utf8');

    expect(source).toContain('supplementary');
    expect(source).toContain('strict node_modules');
    expect(source).toContain('authoritative');
  });

  it('does not report registration names in comments', () => {
    const directory = createRepository();
    writeFixture(
      directory,
      'mcps/x/src/comments.ts',
      "// server.registerTool('line');\n/* server.registerResource('block'); */\n",
    );

    const result = runBoundary(directory);

    expect(result.status).toBe(0);
    expect(outputOf(result)).toContain('Boundary check passed.');
  });

  it('does not scan node_modules or ignored dist files', () => {
    const directory = createRepository();
    writeFixture(directory, '.gitignore', 'dist/\n');
    writeFixture(directory, 'node_modules/vendor/src/a.ts', `import '${serverModule}';\n`);
    writeFixture(directory, 'dist/generated.ts', "server.registerTool('name', {});\n");
    execFileSync('git', ['add', '-f', 'node_modules/vendor/src/a.ts'], { cwd: directory });

    const result = runBoundary(directory);

    expect(result.status).toBe(0);
    expect(outputOf(result)).toContain('Boundary check passed.');
  });

  it('skips tracked files deleted from the working tree', () => {
    const directory = createRepository();
    const deletedPath = join(directory, 'mcps/x/src/deleted.ts');
    mkdirSync(dirname(deletedPath), { recursive: true });
    writeFileSync(deletedPath, `import '${serverModule}';\n`);
    execFileSync('git', ['add', 'mcps/x/src/deleted.ts'], { cwd: directory });
    rmSync(deletedPath);

    const result = runBoundary(directory);

    expect(result.status).toBe(0);
    expect(outputOf(result)).toContain('Boundary check passed.');
  });

  it('passes a clean tree', () => {
    const directory = createRepository();
    writeFixture(directory, 'mcps/x/src/clean.ts', 'export const value = 1;\n');

    const result = runBoundary(directory);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('Boundary check passed.\n');
  });
});
