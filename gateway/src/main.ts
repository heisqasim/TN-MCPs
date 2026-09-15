import { startGateway } from './app.js';

function startupErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : 'Unknown startup error';
  for (const value of Object.values(process.env)) {
    if (value !== undefined && value.length >= 4) {
      message = message.replaceAll(value, '[REDACTED]');
    }
  }
  return JSON.stringify({ error: message });
}

try {
  await startGateway({ installSignalHandlers: true });
} catch (error) {
  console.error(startupErrorMessage(error));
  process.exitCode = 1;
}
