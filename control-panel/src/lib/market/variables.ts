/**
 * Variable resolution engine for youeye-file.yaml templates.
 * Replaces ${variable.path} references with resolved values.
 *
 * Supported variable namespaces:
 *   ${app.id}                 - App identifier
 *   ${install.url}            - Full URL (https://subdomain.domain)
 *   ${install.subdomain}      - User-chosen subdomain
 *   ${install.domain}         - Domain from install config
 *   ${secrets.NAME}           - Generated secret by name
 *   ${container.ip}           - Primary container's IP
 *   ${container.port}         - Primary container's port
 *   ${sso.clientId}           - Authentik OAuth2 client ID
 *   ${sso.clientSecret}       - Authentik OAuth2 client secret
 *   ${authentik.externalUrl}  - Browser-facing Authentik URL
 *   ${authentik.internalUrl}  - Internal Authentik URL
 *   ${authentik.name}         - Identity provider display name (e.g., "HomeCloud ID")
 *   ${smtp.host}              - SMTP server hostname
 *   ${smtp.port}              - SMTP server port
 *   ${smtp.username}          - SMTP username
 *   ${smtp.password}          - SMTP password (from secrets)
 *   ${smtp.from}              - SMTP from address
 *   ${smtp.tls}               - Whether TLS is required ("true"/"false")
 *   ${smtp.configured}        - Whether SMTP is configured ("true"/"false")
 *   ${platform.version}       - YouEye platform version (e.g. "0.2.21")
 *   ${platform.domain}        - Platform root domain
 *   ${platform.siteName}      - Platform display name (white-label)
 *   ${platform.timezone}      - System timezone (e.g. "Australia/Sydney")
 *   ${platform.locale}        - System language code (e.g. "en")
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
 */
function resolvePath(path: string, ctx: Partial<VariableContext>): string | undefined {
  const parts = path.split('.');
  if (parts.length < 2) return undefined;

  const namespace = parts[0];
  const key = parts.slice(1).join('.');

  switch (namespace) {
    case 'app':
      return getNestedValue(ctx.app, key);
    case 'install':
      return getNestedValue(ctx.install, key);
    case 'secrets':
      return ctx.secrets?.[key];
    case 'container':
      return getNestedValue(ctx.container, key);
    case 'sso':
      return getNestedValue(ctx.sso, key);
    case 'authentik':
      return getNestedValue(ctx.authentik, key);
    case 'smtp':
      return getNestedValue(ctx.smtp, key);
    case 'platform':
      return getNestedValue(ctx.platform, key);
    default:
      return undefined;
  }
}

/**
 * Get a nested value from an object by dot-separated key.
 */
function getNestedValue(obj: unknown, key: string): string | undefined {
  if (obj === null || obj === undefined) return undefined;

  const parts = key.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  if (current === undefined || current === null) return undefined;
  return String(current);
}
