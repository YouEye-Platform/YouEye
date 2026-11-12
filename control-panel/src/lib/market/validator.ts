/**
 * Pre-install validation of an app source (`youeye-app.yaml` + setup files):
 *   1. The strict app-format parser (schema, pinned images, variables, setup files)
 *   2. Image reachability (HEAD to the registry)
 *   3. Subdomain collision
 */

import { AppFormatError } from './app-format/parse';
import { loadApp } from './app-format/compile';
import type { AppSource } from './app-format/parse';
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
  checkSubdomain?: string;
}

// ─── Validation Pipeline ──────────────────────────────────────

export async function validateManifest(
  source: AppSource,
  options: ValidateOptions = {}
): Promise<ValidationReport> {
  const { checkImages = true, checkSubdomain } = options;

  const errors: ValidationItem[] = [];
  const warnings: ValidationItem[] = [];
  const info: ValidationItem[] = [];

  // ── Check 1: the one parser ──────────────────────────────

  let manifest: AppManifest;
  try {
    manifest = loadApp(source);
  } catch (error) {
    const issues = error instanceof AppFormatError ? error.issues : [error instanceof Error ? error.message : String(error)];
    for (const issue of issues) {
      errors.push({ check: 'schema', severity: 'error', message: issue });
    }
    return { valid: false, errors, warnings, info };
  }

  // ── Check 2: image reachability ──────────────────────────

  if (checkImages) {
    for (const container of manifest.containers) {
      if (container.type !== 'oci' || !container.image) continue;
      const imgResult = await checkDockerImage(container.image);
      if (imgResult) {
        (imgResult.severity === 'warning' ? warnings : info).push(imgResult);
      }
    }
  }

  // ── Check 3: subdomain collision ─────────────────────────

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

// ─── Image reachability check ─────────────────────────────────

async function checkDockerImage(imageStr: string): Promise<ValidationItem | null> {
  // "ghcr.io/org/app@sha256:…", "docker.io/library/nginx:1.25"
  let registry = 'registry-1.docker.io';
  let image = imageStr;
  let reference = 'latest';

  const at = image.indexOf('@');
  if (at >= 0) {
    reference = image.slice(at + 1);
    image = image.slice(0, at);
  }
  const lastSlash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  if (colon > lastSlash) {
    if (at < 0) reference = image.slice(colon + 1);
    image = image.slice(0, colon);
  }

  const parts = image.split('/');
  if (parts[0]?.includes('.')) {
    const host = parts.shift()!;
    if (host !== 'docker.io') registry = host;
    image = parts.join('/');
  } else if (parts.length === 1) {
    image = `library/${parts[0]}`;
  }

  try {
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
      Accept: 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json',
    };
    if (authHeader) headers.Authorization = authHeader;

    const res = await fetch(
      `https://${registry}/v2/${image}/manifests/${reference}`,
      { method: 'HEAD', headers, signal: AbortSignal.timeout(10_000), redirect: 'error' }
    );

    if (res.status === 404) {
      return {
        check: 'docker-image',
        severity: 'warning',
        message: `Image not found: ${imageStr}`,
        detail: `Registry ${registry} returned 404 for ${image}@${reference}`,
      };
    }
    if (!res.ok) {
      return {
        check: 'docker-image',
        severity: 'info',
        message: `Image check inconclusive: ${imageStr} (HTTP ${res.status})`,
      };
    }
    return null;
  } catch {
    return {
      check: 'docker-image',
      severity: 'info',
      message: `Could not reach registry for ${imageStr}`,
      detail: 'Registry may be temporarily unavailable. This is not necessarily a manifest error.',
    };
  }
}
