/**
 * Variable resolution engine for youeye-app.yaml templates (v2).
 * Replaces ${variable.path} references with resolved values.
 *
 * v2 adds these namespaces on top of v1:
 *   ${platform.locale_full}     - Full language name (e.g. "english")
 *   ${platform.site_name}       - Site display name
 *   ${platform.proxy_ip}        - Caddy container IP
 *   ${database.url}             - Full PostgreSQL connection URL
 *   ${database.dsn}             - DSN format connection string
 *   ${database.host}            - Database hostname
 *   ${database.port}            - Database port
 *   ${database.name}            - Database name
 *   ${database.user}            - Database user
 *   ${database.password}        - Database password
 *   ${integration.gateway_url}  - App gateway API URL
 *   ${integration.app_token}    - Per-app identity token
 *   ${containers.NAME.internal_host}  - Container DNS name
 *   ${containers.NAME.internal_url}   - Container URL with port
 *   ${sso.issuer}               - OIDC issuer URL
 *   ${sso.discovery_url}        - OIDC discovery endpoint
 *   ${sso.client_id}            - OAuth2 client ID
 *   ${sso.client_secret}        - OAuth2 client secret
 *   ${sso.callback_url}         - OAuth2 callback URL
 *   ${sso.logout_url}           - OIDC logout URL
 *
 * Legacy namespaces still supported:
 *   ${app.id}, ${install.*}, ${secrets.*}, ${container.*},
 *   ${authentik.*}, ${smtp.*}, ${platform.*}, ${installParams.*}
 */

import type { VariableContext } from './types';

const VAR_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Resolve all ${...} variable references in a string.
 * Throws if a variable cannot be resolved.
 */
export function resolveVariables(template: string, ctx: Partial<VariableContext>): string {
  return template.replace(VAR_PATTERN, (match, path: string) => {
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
    const result: Record<string, unknown> = {};
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
 * Check if a string contains any unresolved variable references.
 */
export function hasVariables(str: string): boolean {
  return VAR_PATTERN.test(str);
}

/**
 * Resolve a dotted path against the variable context.
 * Supports arbitrary nesting — walks the context object tree.
 */
function resolvePath(path: string, ctx: Partial<VariableContext>): string | undefined {
  const parts = path.split('.');
  if (parts.length < 2) return undefined;

  // Walk the full context object using dot-separated path parts
  let current: unknown = ctx;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  if (current === undefined || current === null) return undefined;
  if (typeof current === 'object') return undefined; // Don't stringify objects
  return String(current);
}
