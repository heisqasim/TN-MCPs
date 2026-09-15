import { z } from 'zod';

import { defineTool } from './contract.js';

export const tnStatusTool = defineTool({
  name: 'tn_status',
  description:
    "Report this Telos MCP server's name, version, MCP specification revision, and negotiated protocol era. Read-only; takes no input.",
  provider: 'tn',
  risk: 'R0',
  scopes: ['tn:read'],
  approval: 'never',
  input: z.object({}),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(_args, context) {
    const status = {
      server: context.server.name,
      version: context.server.version,
      specRevision: '2026-07-28',
      era: context.server.era,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(status) }],
      structuredContent: status,
    };
  },
});
