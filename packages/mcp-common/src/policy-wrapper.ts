import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import type { Principal } from '@tn-mcps/auth';
import { redact, scrubKnownSecrets } from '@tn-mcps/shared';

import type { Logger, ToolContext, ToolResult } from './contract.js';
import type { ToolRegistry } from './registry.js';

const RESULT_SIZE_CAP_BYTES = 49_152;
const INTERACTION_META = { 'anthropic/requiresUserInteraction': true } as const;

export interface PolicyContextBase {
  logger: Logger;
  requestId: string;
  server: ToolContext['server'];
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: scrubKnownSecrets(message) }],
    isError: true,
  };
}

function scrubStringLeaves(value: unknown): unknown {
  if (typeof value === 'string') {
    return scrubKnownSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubStringLeaves);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubStringLeaves(item)]),
    );
  }
  return value;
}

function scrubToolResult(result: ToolResult): ToolResult {
  return scrubStringLeaves(result) as ToolResult;
}

function principalFromContext(context: ServerContext): Principal | undefined {
  const authInfo = context.http?.authInfo;
  if (authInfo === undefined) {
    return undefined;
  }
  const principalKind = authInfo.extra?.principalKind;
  if (principalKind !== 'human' && principalKind !== 'service' && principalKind !== 'dev') {
    return undefined;
  }
  return {
    kind: principalKind,
    id: authInfo.clientId,
    scopes: Object.freeze([...authInfo.scopes]),
  };
}

function redactedErrorMessage(error: unknown): string {
  const safe = redact(error);
  if (typeof safe === 'object' && safe !== null && 'message' in safe) {
    const message = safe.message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return typeof safe === 'string' ? safe : 'Tool handler failed';
}

export function registerWithPolicy(
  server: McpServer,
  registry: ToolRegistry,
  contextBase: PolicyContextBase,
): void {
  for (const definition of registry.list()) {
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.input,
        annotations: definition.annotations,
        ...(definition.risk === 'R0' ? {} : { _meta: INTERACTION_META }),
      },
      async (args, sdkContext) => {
        const principal = principalFromContext(sdkContext);
        if (principal === undefined) {
          return errorResult('verified principal unavailable; refused');
        }

        const missingScopes = definition.scopes.filter(
          (scope) => !principal.scopes.includes(scope),
        );
        if (missingScopes.length > 0) {
          return errorResult(`missing required scope(s): ${missingScopes.join(', ')}`);
        }

        if (definition.risk !== 'R0') {
          return errorResult('approval framework not available until Phase 3; refused');
        }

        const toolContext: ToolContext = {
          ...contextBase,
          principal,
          signal: sdkContext.mcpReq.signal,
        };

        try {
          const result = scrubToolResult(await definition.handler(args, toolContext));
          if (Buffer.byteLength(JSON.stringify(result), 'utf8') > RESULT_SIZE_CAP_BYTES) {
            return errorResult('result exceeded the 48 KiB cap');
          }
          return result;
        } catch (error) {
          const message = redactedErrorMessage(error);
          contextBase.logger.error(
            { error: redact(error), requestId: contextBase.requestId, tool: definition.name },
            'tool handler failed',
          );
          return errorResult(message);
        }
      },
    );
  }
}
