/**
 * SSO configuration engine for youeye-file.yaml manifests.
 * Executes declarative HTTP API steps to configure apps with Authentik SSO.
 *
 * This replaces the per-app TypeScript SSO functions (configureMemosSSO,
 * configureImmichSSO) with a generic HTTP step executor driven by YAML.
 *
 * Re-exports Authentik CRUD operations from the existing sso-setup module.
 */

import type { SSOConfig, SSOStep, VariableContext } from './types';
import { resolveVariables, resolveVariablesDeep } from './variables';

// Re-export Authentik CRUD operations
export {
  isAuthentikAvailable,
  getAuthentikExternalUrl,
  createAuthentikOAuth2App,
  removeAuthentikOAuth2App,
} from './authentik';

/**
 * Runtime context for SSO step execution.
 * Tracks extracted tokens and saved responses across steps.
 */
interface StepContext {
  variables: Partial<VariableContext>;
  tokens: Record<string, string>;
  saved: Record<string, unknown>;
}

/**
 * Execute all SSO configure steps from a manifest.
 * Steps run sequentially — each step can extract tokens used by later steps.
 */
export async function executeSSOSteps(
  sso: SSOConfig,
  baseCtx: Partial<VariableContext>
): Promise<void> {
  if (!sso.setup || sso.setup.method === 'none') return;
  const steps = sso.setup.api?.steps ?? [];
  if (steps.length === 0) return;

  const ctx: StepContext = {
    variables: baseCtx,
    tokens: {},
    saved: {},
  };

  for (const step of steps) {
    await executeStep(step, ctx);
  }
}

async function executeStep(step: SSOStep, ctx: StepContext): Promise<void> {
  // Evaluate condition — but skip pre-evaluation for forEach steps where the
  // condition references the iteration variable (e.g., "provider.title contains 'Authentik'").
  // Those conditions are meant to filter each item, not gate the entire step.
  if (step.condition && !step.forEach && !evaluateCondition(step.condition, ctx)) {
    return;
  }

  // Handle forEach iteration
  if (step.forEach && step.saveAs) {
    const items = ctx.saved[step.saveAs];
    if (Array.isArray(items)) {
      for (const item of items) {
        await executeIterationStep(step, ctx, item);
      }
      return;
    }
  }

  // Handle forEach on a GET response
  if (step.forEach) {
    const response = await executeHTTPStep(step, ctx);
    if (response === null) return;

    const items = extractIterableItems(response, step.forEach);
    if (step.action && items) {
      for (const item of items) {
        if (step.condition) {
          const itemCtx = { ...ctx, saved: { ...ctx.saved, [step.forEach]: item } };
          if (!evaluateCondition(step.condition, itemCtx)) continue;
        }
        await executeActionStep(step.action, ctx, item, step.forEach);
      }
    }
    return;
  }

  // Standard step
  const response = await executeHTTPStep(step, ctx);
  if (response === null) return;

  // Extract token from response
  if (step.extractToken && response) {
    const token = extractValueFromPath(response, step.extractToken.from);
    if (token) {
      ctx.tokens[step.extractToken.as] = String(token);
    }
  }

  // Save response for later steps
  if (step.saveAs && response) {
    ctx.saved[step.saveAs] = response;
  }
}

async function executeHTTPStep(step: SSOStep, ctx: StepContext): Promise<unknown> {
  const url = resolveStepVariables(step.url, ctx);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Apply auth
  if (step.auth) {
    const token = resolveStepVariables(step.auth, ctx);
    headers['Authorization'] = `Bearer ${token}`;
  }

  const options: RequestInit = { method: step.method, headers };

  // Handle body with special merge/set logic
  if (step.body !== undefined) {
    const resolvedBody = resolveBodyWithMerge(step.body, ctx);
    options.body = JSON.stringify(resolvedBody);
  }

  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      if (step.ignoreError) return null;
      const text = await res.text().catch(() => '');
      throw new Error(`SSO step ${step.method} ${url} failed: ${res.status} ${text}`);
    }

    if (res.status === 204) return {};
    const text = await res.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch (err) {
    if (step.ignoreError) return null;
    throw err;
  }
}

async function executeIterationStep(
  step: SSOStep,
  ctx: StepContext,
  item: unknown
): Promise<void> {
  if (!step.forEach) return;
  const itemCtx = { ...ctx, saved: { ...ctx.saved, [step.forEach]: item } };
  if (step.condition && !evaluateCondition(step.condition, itemCtx)) return;
  if (step.action) {
    await executeActionStep(step.action, ctx, item, step.forEach);
  }
}

async function executeActionStep(
  action: NonNullable<SSOStep['action']>,
  ctx: StepContext,
  item: unknown,
  itemKey: string
): Promise<void> {
  // Resolve URL with item context
  let url = action.url;
  // Replace ${itemKey.property} references with item values
  url = url.replace(/\$\{([^}]+)\}/g, (match, path: string) => {
    if (path.startsWith(`${itemKey}.`)) {
      const prop = path.slice(itemKey.length + 1);
      const value = extractValueFromPath(item, prop);
      if (value !== undefined) return String(value);
    }
    return resolveStepVariables(match, ctx);
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (action.auth) {
    headers['Authorization'] = `Bearer ${resolveStepVariables(action.auth, ctx)}`;
  }

  try {
    await fetch(url, {
      method: action.method,
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Actions during iteration are best-effort
  }
}

/**
 * Resolve a body object, handling the special merge/set pattern.
 *
 * If body contains "merge" and "set" keys:
 * - "merge" is a reference to a saved value (spread as base)
 * - "set" contains dot-separated paths to set on the merged result
 *
 * Otherwise, the body is resolved normally with variable substitution.
 */
function resolveBodyWithMerge(body: unknown, ctx: StepContext): unknown {
  if (body === null || body === undefined || typeof body !== 'object') {
    return resolveVariablesDeep(body, ctx.variables);
  }

  const bodyObj = body as Record<string, unknown>;

  if ('merge' in bodyObj && 'set' in bodyObj) {
    // Merge pattern: merge a saved response with new values
    const mergeRef = String(bodyObj.merge);
    const mergeRefResolved = resolveStepVariables(mergeRef, ctx);
    let base: Record<string, unknown> = {};

    // Check if it's a saved reference
    for (const [key, saved] of Object.entries(ctx.saved)) {
      if (mergeRefResolved === `\${${key}}` || mergeRef === `\${${key}}`) {
        base = { ...(saved as Record<string, unknown>) };
        break;
      }
      if (mergeRefResolved === key || mergeRef === key) {
        base = { ...(saved as Record<string, unknown>) };
        break;
      }
    }

    // Apply set values using dot-separated paths
    const setObj = bodyObj.set as Record<string, unknown>;
    for (const [dotPath, value] of Object.entries(setObj)) {
      const resolvedValue = resolveVariablesDeep(value, ctx.variables);
      setNestedValue(base, dotPath, resolvedValue);
    }

    return base;
  }

  // Standard body resolution
  return resolveVariablesDeep(body, ctx.variables);
}

/**
 * Resolve variable references in a step string.
 * Handles both manifest variables (${secrets.x}) and step context (${bearerToken}).
 */
function resolveStepVariables(str: string, ctx: StepContext): string {
  return str.replace(/\$\{([^}]+)\}/g, (match, path: string) => {
    // Check tokens first (step-local context like ${bearerToken})
    if (ctx.tokens[path] !== undefined) {
      return ctx.tokens[path];
    }

    // Try manifest variable resolution
    try {
      return resolveVariables(match, ctx.variables);
    } catch {
      return match;
    }
  });
}

/**
 * Evaluate a simple condition expression.
 * Supports: "!varName" (negation), "varName" (truthy), "var contains 'text'"
 */
function evaluateCondition(condition: string, ctx: StepContext): boolean {
  const trimmed = condition.trim();

  // Negation: !bearerToken
  if (trimmed.startsWith('!')) {
    const varName = trimmed.slice(1);
    return !ctx.tokens[varName];
  }

  // Contains: "provider.title contains 'Authentik'"
  const containsMatch = trimmed.match(/^(\S+)\s+contains\s+'([^']+)'$/);
  if (containsMatch) {
    const [, path, search] = containsMatch;
    const parts = path.split('.');
    if (parts.length >= 2) {
      const itemKey = parts[0];
      const prop = parts.slice(1).join('.');
      const item = ctx.saved[itemKey];
      if (item) {
        const value = extractValueFromPath(item, prop);
        return String(value || '').includes(search);
      }
    }
    return false;
  }

  // Truthy: bearerToken
  return !!ctx.tokens[trimmed];
}

/**
 * Extract a value from an object using a dot-separated path.
 * Supports "response.accessToken" style paths.
 */
function extractValueFromPath(obj: unknown, pathStr: string): unknown {
  if (obj === null || obj === undefined) return undefined;

  // Strip "response." prefix (common in extractToken.from)
  const cleanPath = pathStr.startsWith('response.') ? pathStr.slice(9) : pathStr;
  const parts = cleanPath.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Extract iterable items from a response.
 * Handles common patterns like { identityProviders: [...] } or direct arrays.
 */
function extractIterableItems(response: unknown, _key: string): unknown[] | null {
  if (Array.isArray(response)) return response;
  if (response && typeof response === 'object') {
    // Try common patterns: results, items, data, or the key name
    const obj = response as Record<string, unknown>;
    for (const prop of Object.values(obj)) {
      if (Array.isArray(prop)) return prop;
    }
  }
  return null;
}

/**
 * Set a nested value using a dot-separated path.
 * "oauth.enabled" on obj creates obj.oauth.enabled = value
 */
function setNestedValue(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split('.');
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
}
