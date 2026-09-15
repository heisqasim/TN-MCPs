import { startMcpBackend } from '@tn-mcps/mcp-common';

import { version } from './server.js';

await startMcpBackend({
  processName: 'cloudflare',
  version,
  installSignalHandlers: true,
});
