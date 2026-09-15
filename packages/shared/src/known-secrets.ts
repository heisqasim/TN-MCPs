// Values shorter than 8 characters are too generic to scrub safely, so they are ignored.
const MIN_SECRET_LENGTH = 8;
// A process loading more than this many distinct secrets is misconfigured; fail loudly.
const MAX_KNOWN_SECRETS = 64;

// Longest-first, deduplicated; the order is maintained at registration time so every
// scrub is a single ordered pass without re-sorting.
const knownSecrets: string[] = [];

export function registerSecretValue(value: string): void {
  if (value.length < MIN_SECRET_LENGTH || knownSecrets.includes(value)) {
    return;
  }
  if (knownSecrets.length >= MAX_KNOWN_SECRETS) {
    throw new Error(
      `known-secret registry overflow: a process must not load more than ${MAX_KNOWN_SECRETS} distinct secrets`,
    );
  }
  let index = 0;
  for (; index < knownSecrets.length; index += 1) {
    const existing = knownSecrets[index];
    if (existing !== undefined && existing.length < value.length) {
      break;
    }
  }
  knownSecrets.splice(index, 0, value);
}

export function scrubKnownSecrets(text: string): string {
  let scrubbed = text;
  for (const secret of knownSecrets) {
    scrubbed = scrubbed.replaceAll(secret, '[REDACTED]');
  }
  return scrubbed;
}
