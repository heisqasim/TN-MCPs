const knownSecrets = new Set<string>();

export function registerSecretValue(value: string): void {
  if (value.length >= 8) {
    knownSecrets.add(value);
  }
}

export function scrubKnownSecrets(text: string): string {
  let scrubbed = text;
  const secrets = [...knownSecrets].sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    scrubbed = scrubbed.replaceAll(secret, '[REDACTED]');
  }
  return scrubbed;
}
