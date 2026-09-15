import { type NodeMcpRequestHandler, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { acceptOrCreateRequestId, REQUEST_ID_HEADER } from '@tn-mcps/observability';
import { redact } from '@tn-mcps/shared';

import type { Logger, ToolDefinition } from './contract.js';
import { registerWithPolicy } from './policy-wrapper.js';
import { ToolRegistry } from './registry.js';
import { tnStatusTool } from './tn-status.js';

export interface CreateTelosMcpServerOptions {
  name: string;
  version: string;
  tools?: readonly ToolDefinition[];
  logger: Logger;
}

export interface TelosMcpServer {
  nodeHandler: NodeMcpRequestHandler;
  close(): Promise<void>;
}

export function createTelosMcpServer(options: CreateTelosMcpServerOptions): TelosMcpServer {
  const registry = new ToolRegistry([tnStatusTool, ...(options.tools ?? [])]);
  const handler = createMcpHandler(
    ({ era, requestInfo }) => {
      const server = new McpServer({ name: options.name, version: options.version });
      registerWithPolicy(server, registry, {
        logger: options.logger,
        requestId: acceptOrCreateRequestId(
          requestInfo?.headers.get(REQUEST_ID_HEADER) ?? undefined,
        ),
        server: { name: options.name, version: options.version, era },
      });
      return server;
    },
    {
      legacy: 'stateless',
      responseMode: 'json',
      onerror: (error) => options.logger.error({ error: redact(error) }, 'MCP error'),
    },
  );

  return {
    nodeHandler: toNodeHandler(handler, {
      onerror: (error) => options.logger.error({ error: redact(error) }, 'MCP adapter error'),
    }),
    close: handler.close,
  };
}
