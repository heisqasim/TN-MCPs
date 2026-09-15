import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineTool, type ToolDefinition, ToolRegistry } from '../src/index.js';

function validTool(name = 'test_tool'): ToolDefinition<z.ZodObject<Record<string, never>>> {
  return defineTool({
    name,
    description: 'A valid test tool.',
    provider: 'test',
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
    async handler() {
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  });
}

describe('ToolRegistry', () => {
  it('rejects duplicate names', () => {
    expect(() => new ToolRegistry([validTool(), validTool()])).toThrowError(
      'Duplicate tool name: test_tool',
    );
  });

  it.each(['Upper_case', '_leading', 'contains-dash', 'a'.repeat(65)])(
    'rejects invalid name %s',
    (name) => {
      expect(() => new ToolRegistry([validTool(name)])).toThrowError('Invalid tool name');
    },
  );

  it.each(['', '   '])('rejects an empty description', (description) => {
    expect(() => new ToolRegistry([{ ...validTool(), description }])).toThrowError(
      'must have a non-empty description',
    );
  });

  it('rejects a description longer than 1,024 characters', () => {
    expect(
      () => new ToolRegistry([{ ...validTool(), description: 'd'.repeat(1_025) }]),
    ).toThrowError('description must not exceed 1,024 characters');
  });

  it('rejects the reserved top-level approval_id input', () => {
    const definition = defineTool({
      ...validTool(),
      input: z.object({ approval_id: z.string() }),
    });

    expect(() => new ToolRegistry([definition])).toThrowError('reserved input approval_id');
  });

  it('rejects an R3 tool without always approval', () => {
    expect(
      () =>
        new ToolRegistry([
          {
            ...validTool(),
            risk: 'R3',
            approval: 'policy',
            scopes: ['admin:destructive'],
            annotations: { ...validTool().annotations, destructiveHint: true },
          },
        ]),
    ).toThrowError("must require approval 'always'");
  });

  it('rejects an R3 tool without admin:destructive', () => {
    expect(
      () =>
        new ToolRegistry([
          {
            ...validTool(),
            risk: 'R3',
            approval: 'always',
            scopes: ['tn:read'],
            annotations: { ...validTool().annotations, destructiveHint: true },
          },
        ]),
    ).toThrowError('must include scope admin:destructive');
  });

  it('rejects an R3 tool without destructiveHint', () => {
    expect(
      () =>
        new ToolRegistry([
          {
            ...validTool(),
            risk: 'R3',
            approval: 'always',
            scopes: ['admin:destructive'],
          },
        ]),
    ).toThrowError('must set destructiveHint true');
  });

  it('rejects an R0 tool with gated approval', () => {
    expect(() => new ToolRegistry([{ ...validTool(), approval: 'policy' }])).toThrowError(
      "must require approval 'never'",
    );
  });

  it('rejects an R0 tool without readOnlyHint', () => {
    expect(
      () =>
        new ToolRegistry([
          {
            ...validTool(),
            annotations: { ...validTool().annotations, readOnlyHint: false },
          },
        ]),
    ).toThrowError('must set readOnlyHint true');
  });

  it('rejects an R0 tool with destructiveHint', () => {
    expect(
      () =>
        new ToolRegistry([
          {
            ...validTool(),
            annotations: { ...validTool().annotations, destructiveHint: true },
          },
        ]),
    ).toThrowError('must set destructiveHint false');
  });

  it('lists definitions sorted by name', () => {
    const registry = new ToolRegistry([
      validTool('z_last'),
      validTool('a_first'),
      validTool('m_middle'),
    ]);

    expect(registry.list().map(({ name }) => name)).toEqual(['a_first', 'm_middle', 'z_last']);
  });
});
