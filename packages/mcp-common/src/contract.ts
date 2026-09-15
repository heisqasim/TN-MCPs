import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Principal } from '@tn-mcps/auth';
import type { createLogger } from '@tn-mcps/observability';
import type { z } from 'zod';

export type Risk = 'R0' | 'R1' | 'R2' | 'R3';
export type Approval = 'never' | 'policy' | 'always';
export type Logger = ReturnType<typeof createLogger>;
export type ToolResult = CallToolResult;

export interface ResourceRef {
  kind: string;
  id: string;
  environment?: 'production' | 'staging' | 'unknown';
}

export interface ToolContext {
  principal: Principal;
  requestId: string;
  logger: Logger;
  signal: AbortSignal;
  server: {
    name: string;
    version: string;
    era: string;
  };
}

export interface ToolDefinition<I extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  provider: string;
  risk: Risk;
  scopes: string[];
  approval: Approval;
  input: I;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  resources?(args: z.infer<I>): ResourceRef[];
  precondition?(
    args: z.infer<I>,
    ctx: ToolContext,
  ): Promise<{ stateHash: string; summary: string }>;
  handler(args: z.infer<I>, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool<const I extends z.ZodType>(
  definition: ToolDefinition<I>,
): ToolDefinition<I> {
  return definition;
}
