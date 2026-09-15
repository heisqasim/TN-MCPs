import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const MAX_FILE_SIZE = 1024 * 1024;
const ALLOWLIST = new Set([
  'scripts/guard-secrets.mjs',
  'packages/shared/test/guard-secrets.test.ts',
]);

const contentRules = [
  {
    id: 'private-key',
    pattern: /-----BEGIN [^-\r\n]*PRIVATE KEY-----/g,
  },
  {
    id: 'github-token',
    pattern: /\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  },
  {
    id: 'anthropic-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'openai-key',
    pattern: /\b(?:sk-proj-|sk-(?!ant-))[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    id: 'aws-access-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: 'cloudflare-global-key-usage',
    pattern: /X-Auth-Key/gi,
  },
];

function lineNumberAt(content, index) {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (content.charCodeAt(position) === 10) {
      line += 1;
    }
  }
  return line;
}

function isPlaceholder(value) {
  const unquoted = value.replace(/^(['"])(.*)\1$/, '$2').trim();
  return (
    unquoted === '' ||
    /^<[^>]+>$/.test(unquoted) ||
    /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(unquoted) ||
    /^changeme$/i.test(unquoted) ||
    /^your-.+/i.test(unquoted)
  );
}

function addFinding(findings, path, line, rule) {
  findings.add(`${path}:${line}: ${rule}`);
}

function scanContent(path, content, findings) {
  for (const rule of contentRules) {
    rule.pattern.lastIndex = 0;
    for (const match of content.matchAll(rule.pattern)) {
      addFinding(findings, path, lineNumberAt(content, match.index), rule.id);
    }
  }

  const jwtPattern = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
  for (const match of content.matchAll(jwtPattern)) {
    if (match[0].length >= 60) {
      addFinding(findings, path, lineNumberAt(content, match.index), 'jwt');
    }
  }

  const lines = content.split(/\r?\n/);
  const envAssignment =
    /^\s*(?:export\s+)?(?:CLOUDFLARE_API_TOKEN|CLOUDFLARE_API_KEY|CF_API_TOKEN|TUNNEL_TOKEN|GITHUB_TOKEN|GH_TOKEN)\s*=\s*(.*)$/;
  for (const [index, line] of lines.entries()) {
    const match = envAssignment.exec(line);
    if (match?.[1] !== undefined && !isPlaceholder(match[1])) {
      addFinding(findings, path, index + 1, 'env-assignment');
    }
  }

  if (basename(path) === '.mcp.json') {
    const authorization = /"Authorization"\s*:\s*"([^"\r\n]*)"/gi;
    for (const match of content.matchAll(authorization)) {
      const value = match[1] ?? '';
      if (!/^(?:Bearer\s+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) {
        addFinding(findings, path, lineNumberAt(content, match.index), 'mcp-json-literal-auth');
      }
    }
  }
}

function candidateFiles(rootDir) {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: rootDir },
  );
  return output
    .toString('utf8')
    .split('\0')
    .filter((path) => path.length > 0);
}

function readScannableFile(absolutePath) {
  try {
    if (statSync(absolutePath).size > MAX_FILE_SIZE) {
      return undefined;
    }

    const data = readFileSync(absolutePath);
    return data.subarray(0, 8192).includes(0) ? undefined : data;
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function main() {
  const rootDir = resolve(process.argv[2] ?? process.cwd());
  const findings = new Set();

  for (const path of candidateFiles(rootDir)) {
    if (ALLOWLIST.has(path)) {
      continue;
    }

    const name = basename(path);
    if (name !== '.env.example' && (name === '.env' || name.startsWith('.env.'))) {
      addFinding(findings, path, 1, 'tracked-env-file');
    }

    const absolutePath = resolve(rootDir, path);
    const data = readScannableFile(absolutePath);
    if (data === undefined) {
      continue;
    }

    scanContent(path, data.toString('utf8'), findings);
  }

  if (findings.size > 0) {
    for (const finding of [...findings].sort()) {
      console.error(finding);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Secret guard passed.');
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message.split('\n', 1)[0] : 'unknown error';
  console.error(`secret guard failed to scan repository: ${message}`);
  process.exitCode = 2;
}
