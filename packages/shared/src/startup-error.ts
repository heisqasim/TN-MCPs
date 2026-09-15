import { scrubKnownSecrets } from './known-secrets.js';

export function formatStartupError(
  error: unknown,
  env: Record<string, string | undefined> = process.env,
): string {
  let message = scrubKnownSecrets(error instanceof Error ? error.message : 'Unknown startup error');
  const environmentValues = Object.values(env)
    .filter((value): value is string => value !== undefined && value.length >= 4)
    .sort((left, right) => right.length - left.length);
  for (const value of environmentValues) {
    message = message.replaceAll(value, '[REDACTED]');
  }
  return JSON.stringify({ error: message });
}
