import { readFileSync } from 'node:fs';

import {
  type RunningMcpBackend,
  type StartMcpBackendOptions,
  startMcpBackend,
} from '@tn-mcps/mcp-common';

interface PackageMetadata {
  version: string;
}

export interface StartCloudflareMcpOptions {
  env?: StartMcpBackendOptions['env'];
  listenPortOverride?: number;
  installSignalHandlers?: boolean;
}

const packageMetadata = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageMetadata;

export const version = packageMetadata.version;

export function startCloudflareMcp(
  options: StartCloudflareMcpOptions = {},
): Promise<RunningMcpBackend> {
  return startMcpBackend({
    processName: 'cloudflare',
    version,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.listenPortOverride === undefined
      ? {}
      : { listenPortOverride: options.listenPortOverride }),
    ...(options.installSignalHandlers === undefined
      ? {}
      : { installSignalHandlers: options.installSignalHandlers }),
  });
}
