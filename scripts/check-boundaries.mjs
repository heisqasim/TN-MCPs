// Architecture boundary gate for the Telos Nexus MCP control plane (MASTER_PLAN §A.3).
//
// The pattern scan is a supplementary gate: it greps sources for known escape hatches so
// a regression fails CI even before any code runs. The structural B1 enforcement is
// pnpm's strict node_modules — an undeclared package cannot be resolved — which makes
// the package.json dependency check below the authoritative part of B1.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const CODE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.tsx', '.jsx']);
const ALLOWLIST = new Set([
  'scripts/check-boundaries.mjs',
  'packages/shared/test/check-boundaries.test.ts',
]);
const RESTRICTED_MODULE = /^@modelcontextprotocol\/(?:server|node|express|hono|fastify)(?:\/.*)?$/;

function lineNumberAt(content, index) {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (content.charCodeAt(position) === 10) {
      line += 1;
    }
  }
  return line;
}

function addFinding(findings, path, line, rule) {
  findings.add(`${path}:${line}: ${rule}`);
}

function isMcpCommonPath(path) {
  return path.startsWith('packages/mcp-common/');
}

function isIgnoredDirectory(path) {
  return path.split('/').some((part) => part === 'node_modules' || part === 'dist');
}

function stripComments(content) {
  let result = '';
  let state = 'code';
  let stringDelimiter = '';

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];

    if (state === 'line-comment') {
      if (character === '\n' || character === '\r') {
        result += character;
        state = 'code';
      } else {
        result += ' ';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        result += '  ';
        index += 1;
        state = 'code';
      } else if (character === '\n' || character === '\r') {
        result += character;
      } else {
        result += ' ';
      }
      continue;
    }

    if (state === 'string' || state === 'template') {
      result += character;
      if (character === '\\' && index + 1 < content.length) {
        result += content[index + 1];
        index += 1;
      } else if (state === 'string' && character === stringDelimiter) {
        state = 'code';
        stringDelimiter = '';
      } else if (state === 'template' && character === '`') {
        state = 'code';
      }
      continue;
    }

    if (character === '/' && next === '/') {
      result += '  ';
      index += 1;
      state = 'line-comment';
    } else if (character === '/' && next === '*') {
      result += '  ';
      index += 1;
      state = 'block-comment';
    } else {
      result += character;
      if (character === "'" || character === '"') {
        state = 'string';
        stringDelimiter = character;
      } else if (character === '`') {
        state = 'template';
      }
    }
  }

  return result;
}

function isRestrictedModule(specifier) {
  return RESTRICTED_MODULE.test(specifier) && !specifier.includes('${');
}

// An npm alias dependency ("name": "npm:@modelcontextprotocol/server@2.0.0") smuggles a
// restricted module in under an innocent key, so aliases must resolve to their target.
function aliasedNpmModule(value) {
  if (typeof value !== 'string' || !value.startsWith('npm:')) {
    return undefined;
  }
  const spec = value.slice('npm:'.length);
  const versionSeparator = spec.lastIndexOf('@');
  const moduleName = versionSeparator > 0 ? spec.slice(0, versionSeparator) : spec;
  return isRestrictedModule(moduleName) ? moduleName : undefined;
}

function addImportFindings(content, path, findings) {
  const importPatterns = [
    /\bimport\s+(?:(?:[\s\S]*?)\sfrom\s+)?(['"`])([^'"`]*?)\1/g,
    /\bexport\s+(?:[\s\S]*?\sfrom\s+)(['"`])([^'"`]*?)\1/g,
    /\bimport\s*\(\s*(['"`])([^'"`]*?)\1\s*\)/g,
    /\brequire\s*\(\s*(['"`])([^'"`]*?)\1\s*\)/g,
  ];

  for (const pattern of importPatterns) {
    for (const match of content.matchAll(pattern)) {
      if (isRestrictedModule(match[2])) {
        addFinding(findings, path, lineNumberAt(content, match.index), 'B1-server-sdk-import');
      }
    }
  }
}

function addRegistrationFindings(content, path, findings) {
  const withoutComments = stripComments(content);
  const registrationPatterns = [
    [/\bregister(?:Tool|Resource|Prompt)\s*\(/g, 'B2-registration-call'],
    [/\bset(?:Request|Notification)Handler\s*\(/g, 'B2-low-level-handler-call'],
  ];

  for (const [pattern, rule] of registrationPatterns) {
    for (const match of withoutComments.matchAll(pattern)) {
      addFinding(findings, path, lineNumberAt(withoutComments, match.index), rule);
    }
  }
}

function addDependencyFindings(content, path, findings) {
  const packageJson = JSON.parse(content);
  const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

  for (const section of sections) {
    const dependencies = packageJson[section];
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      continue;
    }

    for (const [dependency, target] of Object.entries(dependencies)) {
      if (isRestrictedModule(dependency) || aliasedNpmModule(target) !== undefined) {
        addFinding(
          findings,
          path,
          lineNumberAt(content, content.indexOf(`"${dependency}"`)),
          'B1-server-sdk-dependency',
        );
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

function fileExtension(path) {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot).toLowerCase();
}

function scanFile(rootDir, path, findings) {
  let content;
  try {
    content = readFileSync(resolve(rootDir, path), 'utf8');
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  if (basename(path) === 'package.json' && !isMcpCommonPath(path)) {
    addDependencyFindings(content, path, findings);
  }

  if (CODE_EXTENSIONS.has(fileExtension(path))) {
    const withoutComments = stripComments(content);
    if (!isMcpCommonPath(path)) {
      addImportFindings(withoutComments, path, findings);
    }
    if (path !== 'packages/mcp-common/src/policy-wrapper.ts') {
      addRegistrationFindings(content, path, findings);
    }
  }
}

function main() {
  const rootDir = resolve(process.argv[2] ?? process.cwd());
  const findings = new Set();

  for (const path of candidateFiles(rootDir)) {
    if (ALLOWLIST.has(path) || isIgnoredDirectory(path)) {
      continue;
    }
    scanFile(rootDir, path, findings);
  }

  if (findings.size > 0) {
    for (const finding of [...findings].sort()) {
      console.error(finding);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Boundary check passed.');
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message.split('\n', 1)[0] : 'unknown error';
  console.error(`boundary check failed to scan repository: ${message}`);
  process.exitCode = 2;
}
