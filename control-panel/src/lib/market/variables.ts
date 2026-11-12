/**
 * Variable resolution for app manifests and setup files: replaces `${name}` with values from a
 * `VariableContext`. The names are those of the registry in `app-format/variables.ts`
 * (docs/app-environment.md).
 */

import type { VariableContext } from './types';

const VAR_PATTERN = () => /\$\{([^}]+)\}/g;

/**
 * Resolve all ${...} variable references in a string.
 * Throws if a variable cannot be resolved.
 */
export function resolveVariables(template: string, ctx: Partial<VariableContext>): string {
  return template.replace(VAR_PATTERN(), (match, path: string) => {
    const value = resolvePath(path.trim(), ctx);
    if (value === undefined) {
      throw new Error(`Unresolved variable: ${match}`);
    }
    return value;
  });
}

/**
 * Resolve variables in all string values of an object (deep).
 * Non-string values are passed through unchanged.
 */
export function resolveVariablesDeep(obj: unknown, ctx: Partial<VariableContext>): unknown {
  if (typeof obj === 'string') {
    return resolveVariables(obj, ctx);
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveVariablesDeep(item, ctx));
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveVariablesDeep(value, ctx);
    }
    return result;
  }
  return obj;
}

/**
 * Resolve variables in a record of string values (environment variables).
 */
export function resolveEnvironment(
  env: Record<string, string>,
  ctx: Partial<VariableContext>
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    resolved[key] = resolveVariables(value, ctx);
  }
  return resolved;
}

/**
 * Check if a string contains any variable references.
 */
export function hasVariables(str: string): boolean {
  return VAR_PATTERN().test(str);
}

/**
 * Resolve a dotted path against the variable context, walking own properties only.
 * Objects are never stringified.
 */
export function resolvePath(path: string, ctx: unknown): string | undefined {
  const parts = path.split('.');
  if (parts.length < 2) return undefined;

  let current: unknown = ctx;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  if (current === undefined || current === null) return undefined;
  if (typeof current === 'object') return undefined;
  return String(current);
}
