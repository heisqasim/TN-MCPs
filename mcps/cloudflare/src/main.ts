import { startMcpBackend } from '@tn-mcps/mcp-common';
import { formatStartupError } from '@tn-mcps/shared';

import { version } from './server.js';

try {
  await startMcpBackend({
    processName: 'cloudflare',
    version,
    installSignalHandlers: true,
  });
} catch (error) {
  console.error(formatStartupError(error));
  process.exitCode = 1;
}
