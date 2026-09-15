import type { z } from 'zod';

export class ConfigError extends Error {
  readonly variables: string[];

  constructor(variables: string[], details: string[]) {
    super(`Invalid configuration:\n${details.map((detail) => `- ${detail}`).join('\n')}`);
    this.name = 'ConfigError';
    this.variables = variables;
  }
}

function sanitizeMessage(message: string, env: Record<string, string | undefined>): string {
  const receivedValues = Object.values(env)
    .filter((value): value is string => typeof value === 'string' && value.length >= 4)
    .sort((left, right) => right.length - left.length);

  return receivedValues.reduce(
    (safeMessage, receivedValue) => safeMessage.replaceAll(receivedValue, '[REDACTED]'),
    message,
  );
}

export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (result.success) {
    return result.data;
  }

  const variables: string[] = [];
  const details = result.error.issues.map((issue) => {
    const variable = issue.path.length > 0 ? String(issue.path[0]) : '(root)';
    if (!variables.includes(variable)) {
      variables.push(variable);
    }
    return `${variable}: ${sanitizeMessage(issue.message, env)}`;
  });

  throw new ConfigError(variables, details);
}
