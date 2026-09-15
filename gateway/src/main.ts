import { formatStartupError } from '@tn-mcps/shared';

import { startGateway } from './app.js';

try {
  await startGateway({ installSignalHandlers: true });
} catch (error) {
  console.error(formatStartupError(error));
  process.exitCode = 1;
}
