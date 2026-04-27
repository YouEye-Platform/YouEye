/**
 * Manifest validation pipeline for youeye-file.yaml manifests.
 *
 * Runs 8 pre-install checks:
 *   1. Zod schema validation
 *   2. Template variable dry-run
 *   3. Docker image reachability (HEAD to registry)
 *   4. Icon URL reachability
 *   5. Screenshot URL reachability
 *   6. SSO roleClaim scope coherence (F2)
 *   7. SSO structure coherence
 *   8. Subdomain collision check
 */

import { AppManifestSchema } from './schema';
import type { AppManifest } from './types';

// ─── Types ────────────────────────────────────────────────────

export interface ValidationItem {
  check: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  detail?: string;
}

export interface ValidationReport {
  valid: boolean;
  errors: ValidationItem[];
  warnings: ValidationItem[];
  info: ValidationItem[];
}

export interface ValidateOptions {
  checkImages?: boolean;
  checkUrls?: boolean;
  checkSubdomain?: string;
  skipSSO?: boolean;
}

// ─── Helpers shared with engine (F2 roleClaim) ────────────────

/**
 * Recursively find all fields in an object whose key matches a pattern.
 */
export function findFieldsContaining(
  obj: unknown,
  pattern: RegExp,
  prefix = ''
): Array<{ path: string; value: unknown }> {
  const results: Array<{ path: string; value: unknown }> = [];
  if (typeof obj !== 'object' || obj === null) return results;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (pattern.test(key)) {
      results.push({ path, value });
    }
    if (typeof value === 'object' && value !== null) {
      results.push(...findFieldsContaining(value, pattern, path));
    }
  }
  return results;
}

/**
 * Check if a roleClaim admin mapping's claimName is present in the SSO
 * configure step scope fields. Returns a warning item if missing.
 */
export function checkRoleClaimScope(manifest: AppManifest): ValidationItem | null {
  const adminMapping = manifest.sso?.adminMapping;
  if (!adminMapping || adminMapping.type !== 'roleClaim') return null;

  const claimName = adminMapping.claimName;
  const steps = manifest.sso?.setup?.api?.steps ?? [];

  for (const [stepIndex, step] of steps.entries()) {
    if (!step.body) continue;
    const scopeFields = findFieldsContaining(step.body, /scope/i);
    for (const { path, value } of scopeFields) {
      if (typeof value === 'string' && !value.includes(claimName)) {
        return {
          check: 'sso-scope',
          severity: 'warning',
          message: `Admin mapping may fail: scope in configure step ${stepIndex + 1} does not include "${claimName}"`,
          detail: `Field "${path}" has value "${value}" — missing custom claim "${claimName}". ` +
                  `Authentik only sends claims for scopes the client requests. Without "${claimName}" in the scope, ` +
                  `the admin role claim will be silently excluded from the token.`,
        };
      }
    }
  }
  return null;
}

// ─── Validation Pipeline ──────────────────────────────────────

export async function validateManifest(
  rawManifest: unknown,
  options: ValidateOptions = {}
): Promise<ValidationReport> {
  const {
    checkImages = true,
    checkUrls = true,
    checkSubdomain,
    skipSSO = false,
  } = options;

  const errors: ValidationItem[] = [];
  const warnings: ValidationItem[] = [];
  const info: ValidationItem[] = [];

  // ── Check 1: Zod schema ──────────────────────────────────

  const parsed = AppManifestSchema.safeParse(rawManifest);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({
        check: 'schema',
        severity: 'error',
        message: `Schema: ${issue.path.join('.')} — ${issue.message}`,
        detail: JSON.stringify(issue),
      });
    }
    return { valid: false, errors, warnings, info };
  }

  const manifest = parsed.data as AppManifest;

  // ── Check 2: Template variable dry-run ───────────────────

  const knownVars = new Set([
    'app.id', 'app.name', 'app.url', 'install.subdomain', 'install.domain', 'install.url',
    'platform.domain', 'platform.ip', 'platform.protocol', 'platform.locale_full',
    'authentik.clientId', 'authentik.clientSecret', 'authentik.slug',
    'authentik.externalUrl', 'authentik.name',
    'sso.client_id', 'sso.client_secret', 'sso.slug',
    'database.host', 'database.port', 'database.name', 'database.user', 'database.password',
    'container.ip', 'container.port',
  ]);
  // Add secret names
  for (const secret of manifest.secrets ?? []) {
    knownVars.add(`secrets.${secret.name}`);
  }
  // Add SSO step-extracted tokens (extractToken.as, extractCookie.as) as known
  const ssoSteps = manifest.sso?.setup?.api?.steps ?? [];
  for (const step of ssoSteps) {
    if (step.extractToken?.as) knownVars.add(step.extractToken.as);
    if (step.extractCookie?.as) knownVars.add(step.extractCookie.as);
    if (step.saveAs) knownVars.add(step.saveAs);
  }
  // Scan all string fields for unresolvable ${...} references
  const unresolved = new Set<string>();
  JSON.stringify(manifest).replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
    // Skip known vars, step tokens, and saved response references
    if (!knownVars.has(varName) && !varName.includes('.')) {
      // Only flag simple (non-dotted) unknown vars — dotted paths like
      // ${savedResponse.field} are too dynamic to validate statically
      unresolved.add(varName);
    } else if (varName.includes('.') && !knownVars.has(varName)) {
      // For dotted paths, check if the root is known
      const root = varName.split('.')[0];
      const knownRoots = new Set(['secrets', 'container', 'containers', 'database',
        'platform', 'app', 'install', 'authentik', 'sso', 'smtp', 'provider']);
      // Also accept container names declared in the manifest (e.g. containers.valkey.*)
      for (const c of manifest.containers) { if (c.name) knownRoots.add(c.name); }
      if (!knownVars.has(root) && !knownRoots.has(root)) {
        unresolved.add(varName);
      }
    }
    return '';
  });
  for (const v of unresolved) {
    warnings.push({
      check: 'template-vars',
      severity: 'warning',
      message: `Unrecognized template variable: \${${v}}`,
      detail: `This variable may resolve at runtime, but is not in the known set. Verify it is intentional.`,
    });
  }

  // ── Check 3: Docker image reachability ───────────────────

  if (checkImages) {
    for (const container of manifest.containers) {
      if (container.type !== 'oci' || !container.image) continue;
      const imgResult = await checkDockerImage(container.image);
      if (imgResult) {
        (imgResult.severity === 'warning' ? warnings : info).push(imgResult);
      }
    }
  }

  // ── Check 4: Icon URL reachability ───────────────────────

  if (checkUrls && manifest.metadata.iconUrl) {
    const iconResult = await checkUrl(manifest.metadata.iconUrl, 'icon-url');
    if (iconResult) warnings.push(iconResult);
  }

  // ── Check 5: Screenshot URLs ─────────────────────────────

  if (checkUrls && manifest.detail?.screenshots) {
    for (const ss of manifest.detail.screenshots) {
      const ssUrl = typeof ss === 'string' ? ss : ss.path;
      const ssResult = await checkUrl(ssUrl, 'screenshot-url');
      if (ssResult) warnings.push(ssResult);
    }
  }

  // ── Check 6: SSO roleClaim scope (F2) ────────────────────

  if (!skipSSO) {
    const roleClaimResult = checkRoleClaimScope(manifest);
    if (roleClaimResult) warnings.push(roleClaimResult);
  }

  // ── Check 7: SSO structure coherence ─────────────────────

  if (!skipSSO && manifest.sso) {
    const method = manifest.sso.setup?.method;
    if (method === 'api') {
      const steps = manifest.sso.setup?.api?.steps ?? [];
      if (steps.length === 0) {
        errors.push({
          check: 'sso-structure',
          severity: 'error',
          message: 'SSO method is "api" but configure steps are empty',
          detail: 'The manifest declares API-based SSO but has no steps to execute.',
        });
      }
    } else if (method === 'cli') {
      const cliSteps = manifest.sso.setup?.cli?.steps ?? [];
      if (cliSteps.length === 0) {
        errors.push({
          check: 'sso-structure',
          severity: 'error',
          message: 'SSO method is "cli" but CLI steps are empty',
          detail: 'The manifest declares CLI-based SSO but has no commands to execute.',
        });
      }
    }
  }

  // ── Check 8: Subdomain collision ─────────────────────────

  if (checkSubdomain) {
    try {
      const { getAllInstalledApps } = await import('./installed-apps');
      const installed = await getAllInstalledApps();
      const taken = installed.some(a => a.subdomain === checkSubdomain);
      if (taken) {
        errors.push({
          check: 'subdomain',
          severity: 'error',
          message: `Subdomain "${checkSubdomain}" is already in use`,
          detail: 'Choose a different subdomain for this app.',
        });
      }
    } catch {
      info.push({
        check: 'subdomain',
        severity: 'info',
        message: 'Could not check subdomain availability',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    info,
  };
}

// ─── Docker image reachability check ──────────────────────────

async function checkDockerImage(imageStr: string): Promise<ValidationItem | null> {
  // Parse "docker.io/library/nginx:1.25" or "ghcr.io/org/app:tag"
  let registry = 'registry-1.docker.io';
  let image = imageStr;
  let tag = 'latest';

  const tagSplit = image.split(':');
  if (tagSplit.length >= 2) {
    tag = tagSplit.pop()!;
    image = tagSplit.join(':');
  }

  const parts = image.split('/');
  if (parts[0]?.includes('.')) {
    const host = parts.shift()!;
    if (host === 'docker.io') registry = 'registry-1.docker.io';
    else registry = host;
    image = parts.join('/');
  } else if (parts.length === 1) {
    image = `library/${parts[0]}`;
  }

  try {
    // Get anonymous token for docker.io
    let authHeader = '';
    if (registry === 'registry-1.docker.io') {
      const tokenRes = await fetch(
        `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${image}:pull`,
        { signal: AbortSignal.timeout(10_000) }
      );
      if (tokenRes.ok) {
        const tokenData = await tokenRes.json() as { token?: string };
        if (tokenData.token) authHeader = `Bearer ${tokenData.token}`;
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json',
    };
    if (authHeader) headers.Authorization = authHeader;

    const res = await fetch(
      `https://${registry}/v2/${image}/manifests/${tag}`,
      { method: 'HEAD', headers, signal: AbortSignal.timeout(10_000) }
    );

    if (res.status === 404) {
      return {
        check: 'docker-image',
        severity: 'warning',
        message: `Docker image not found: ${imageStr}`,
        detail: `Registry ${registry} returned 404 for ${image}:${tag}`,
      };
    }
    if (!res.ok) {
      return {
        check: 'docker-image',
        severity: 'info',
        message: `Docker image check inconclusive: ${imageStr} (HTTP ${res.status})`,
      };
    }
    return null; // passed
  } catch {
    return {
      check: 'docker-image',
      severity: 'info',
      message: `Could not reach registry for ${imageStr}`,
      detail: 'Registry may be temporarily unavailable. This is not necessarily a manifest error.',
    };
  }
}

// ─── URL reachability check ───────────────────────────────────

async function checkUrl(url: string, check: string): Promise<ValidationItem | null> {
  // Skip template variable URLs
  if (url.includes('${')) return null;
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(10_000),
      redirect: 'follow',
    });
    if (res.status === 404) {
      return {
        check,
        severity: 'warning',
        message: `URL returned 404: ${url}`,
        detail: 'Resource not found. App will use fallback icon.',
      };
    }
    if (!res.ok) {
      return {
        check,
        severity: 'warning',
        message: `URL returned ${res.status}: ${url}`,
      };
    }
    return null;
  } catch {
    return {
      check,
      severity: 'info',
      message: `Could not reach URL: ${url}`,
    };
  }
}
