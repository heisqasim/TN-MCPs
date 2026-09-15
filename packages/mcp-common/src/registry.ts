import { z } from 'zod';

import type { ToolDefinition } from './contract.js';

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function hasReservedApprovalId(definition: ToolDefinition): boolean {
  const schema = z.toJSONSchema(definition.input);
  if (schema.type !== 'object' || schema.properties === undefined) {
    return false;
  }
  return Object.hasOwn(schema.properties, 'approval_id');
}

function validateDefinition(definition: ToolDefinition): void {
  if (!TOOL_NAME_PATTERN.test(definition.name)) {
    throw new Error(`Invalid tool name: ${definition.name}`);
  }
  if (definition.description.trim().length === 0) {
    throw new Error(`Tool ${definition.name} must have a non-empty description`);
  }
  if ([...definition.description].length > 1_024) {
    throw new Error(`Tool ${definition.name} description must not exceed 1,024 characters`);
  }
  if (hasReservedApprovalId(definition)) {
    throw new Error(`Tool ${definition.name} must not define reserved input approval_id`);
  }
  if (definition.risk === 'R3') {
    if (definition.approval !== 'always') {
      throw new Error(`R3 tool ${definition.name} must require approval 'always'`);
    }
    if (!definition.scopes.includes('admin:destructive')) {
      throw new Error(`R3 tool ${definition.name} must include scope admin:destructive`);
    }
    if (!definition.annotations.destructiveHint) {
      throw new Error(`R3 tool ${definition.name} must set destructiveHint true`);
    }
  }
  if (definition.risk === 'R0') {
    if (definition.approval !== 'never') {
      throw new Error(`R0 tool ${definition.name} must require approval 'never'`);
    }
    if (!definition.annotations.readOnlyHint) {
      throw new Error(`R0 tool ${definition.name} must set readOnlyHint true`);
    }
    if (definition.annotations.destructiveHint) {
      throw new Error(`R0 tool ${definition.name} must set destructiveHint false`);
    }
  }
}

export class ToolRegistry {
  readonly #definitions: readonly ToolDefinition[];

  constructor(definitions: readonly ToolDefinition[]) {
    const names = new Set<string>();
    for (const definition of definitions) {
      if (names.has(definition.name)) {
        throw new Error(`Duplicate tool name: ${definition.name}`);
      }
      names.add(definition.name);
      validateDefinition(definition);
    }
    this.#definitions = Object.freeze(
      [...definitions].sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  list(): readonly ToolDefinition[] {
    return this.#definitions;
  }
}
