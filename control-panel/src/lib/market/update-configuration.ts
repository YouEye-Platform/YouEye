import type { AppManifest, VariableContext } from './types';
import { resolveVariables } from './variables';

const protectedPath = /^(?:database|sso|identity|integration|ai|installParams)\./;

/** Recover chosen credentials/settings from the old declared environment, never
 * minting an integration token or replacing a secret with a canonical default. */
export function updateConfigurationContext(
  old: AppManifest, environments: Record<string, Record<string, string>>,
  canonical: Partial<VariableContext>,
): Partial<VariableContext> {
  const context = structuredClone(canonical);
  const seen = new Map<string, string>();
  for (const spec of old.containers) {
    const declarations = { ...old.env_mapping, ...spec.environment };
    for (const [key, template] of Object.entries(declarations)) {
      const path = /^\$\{([A-Za-z_][A-Za-z0-9_.]*)\}$/.exec(template)?.[1];
      const value = environments[spec.name]?.[key];
      if (!path || !protectedPath.test(path) || value === undefined) continue;
      if (seen.has(path) && seen.get(path) !== value) throw new Error('Installed environment has inconsistent credential context');
      seen.set(path, value);
      const parts = path.split('.');
      let parent = context as Record<string, unknown>;
      for (const part of parts.slice(0, -1)) {
        if (['__proto__', 'constructor', 'prototype'].includes(part)) throw new Error('Invalid update variable');
        if (!parent[part] || typeof parent[part] !== 'object') parent[part] = {};
        parent = parent[part] as Record<string, unknown>;
      }
      const field = parts.at(-1)!;
      if (['__proto__', 'constructor', 'prototype'].includes(field)) throw new Error('Invalid update variable');
      parent[field] = value;
    }
  }
  return context;
}

export function resolveUpdateTemplate(template: string, ctx: Partial<VariableContext>): string {
  // Empty bootstrap defaults are insufficient evidence for a new credential.
  // Existing empty optional mappings remain valid by retaining them unchanged.
  for (const match of template.matchAll(/\$\{([^}]+)\}/g)) {
    if (protectedPath.test(match[1]) && resolveVariables(match[0], ctx) === '') {
      throw new Error('Update requires an unavailable installed credential or setting');
    }
  }
  return resolveVariables(template, ctx);
}

export function updateEnvironment(
  oldDeclarations: Record<string, string>, targetDeclarations: Record<string, string>,
  current: Record<string, string>, context: Partial<VariableContext>,
): Record<string, string> {
  const next = { ...current };
  for (const key of Object.keys(oldDeclarations)) {
    if (!Object.hasOwn(targetDeclarations, key)) delete next[key];
  }
  for (const [key, template] of Object.entries(targetDeclarations)) {
    if (template === oldDeclarations[key] && /\$\{(?:database|sso|identity|integration|ai|installParams)\./.test(template)) {
      if (!Object.hasOwn(current, key)) throw new Error('Installed credential mapping is missing');
      next[key] = current[key];
    } else {
      next[key] = resolveUpdateTemplate(template, context);
    }
  }
  return next;
}
