import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type StartCloudflareMcpOptions, startCloudflareMcp } from '../src/server.js';

const developmentCredential = ['cloudflare', 'module', 'credential'].join('-');

function environment(tokenFile: string): NonNullable<StartCloudflareMcpOptions['env']> {
  return {
    NODE_ENV: 'development',
    TN_AUTH_MODE: 'dev',
    TN_DEV_TOKEN_FILE: tokenFile,
    TN_BIND_HOST: '127.0.0.1',
    TN_LOG_LEVEL: 'silent',
  };
}

describe('@tn-mcps/mcp-cloudflare module wiring', () => {
  let directory: string;
  let tokenFile: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tn-cloudflare-module-'));
    tokenFile = join(directory, 'dev-token');
    await writeFile(tokenFile, developmentCredential, { mode: 0o600 });
  });

  afterAll(async () => {
    await rm(directory, { recursive: true });
  });

  it('starts on an ephemeral loopback port and exposes exactly tn_status', async () => {
    const backend = await startCloudflareMcp({
      env: environment(tokenFile),
      listenPortOverride: 0,
    });
    const client = new Client({ name: 'cloudflare-module-test', version: '1.0.0' });

    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(backend.url), {
          requestInit: { headers: { 'x-tn-dev-assertion': developmentCredential } },
        }),
      );
      const listed = await client.listTools();
      expect(listed.tools.map(({ name }) => name)).toEqual(['tn_status']);
    } finally {
      await client.close();
      await backend.close();
    }
  });
});
