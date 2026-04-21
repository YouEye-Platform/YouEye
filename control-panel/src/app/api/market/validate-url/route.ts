/**
 * Manifest URL Validation Endpoint
 *
 * POST /api/market/validate-url
 * Body: { manifestUrl: string }
 *
 * Fetches a YAML manifest from a URL, validates it against the schema,
 * and returns the parsed manifest or validation errors.
 *
 * Security:
 *   - HTTPS only (no http://, file://, etc.)
 *   - SSRF prevention: blocks RFC1918 private IPs
 *   - Max response size: 1MB
 *   - Timeout: 5 seconds
 *   - Safe YAML parsing (no executable content)
 */

import { NextRequest, NextResponse } from 'next/server';
import { parse as parseYAML } from 'yaml';
import { AppManifestSchema } from '@/lib/market/schema';
import { CONTAINER_DOMAIN } from '@/lib/market/constants';
import type { AppManifest, MarketApp } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

const MAX_SIZE_BYTES = 1024 * 1024; // 1MB
const FETCH_TIMEOUT_MS = 5000;

/** RFC1918 + loopback IP ranges that should be blocked for SSRF prevention */
const PRIVATE_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/,
  /^fe80:/,
  /^fd/,
  /^localhost$/i,
];

/**
 * Check if a hostname resolves to a private/internal IP.
 * Returns true if the URL targets an internal address (SSRF risk).
 */
function isPrivateHostname(hostname: string): boolean {
  // Direct IP check
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      return true;
    }
  }

  // Block common internal hostnames
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith(`.${CONTAINER_DOMAIN}`) ||
    hostname.endsWith('.incus') ||
    hostname.endsWith('.test')
  ) {
    return true;
  }

  return false;
}

/**
 * Validate a manifest URL for safety.
 * Returns an error string if invalid, or null if safe.
 */
function validateUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL format';
  }

  if (parsed.protocol !== 'https:') {
    return 'Only HTTPS URLs are allowed';
  }

  if (isPrivateHostname(parsed.hostname)) {
    return 'URL must point to a public server (private/internal IPs are blocked)';
  }

  // Block URLs with authentication credentials
  if (parsed.username || parsed.password) {
    return 'URLs with embedded credentials are not allowed';
  }

  return null;
}

/**
 * Convert a parsed manifest to a MarketApp preview for the UI.
 */
function manifestToPreview(manifest: AppManifest): MarketApp {
  return {
    id: manifest.metadata.id,
    name: manifest.metadata.name,
    description: manifest.metadata.description,
    icon: manifest.metadata.icon,
    iconUrl: manifest.metadata.iconUrl,
    category: manifest.metadata.category,
    integration: manifest.integration,
    version: manifest.version,
    defaultSubdomain: manifest.metadata.defaultSubdomain,
    supportsSSO: !!manifest.sso,
    website: manifest.metadata.website,
    tags: manifest.metadata.tags,
    detail: manifest.detail ? {
      longDescription: manifest.detail.longDescription,
      screenshots: manifest.detail.screenshots.map((s) => ({
        url: s.path,
        caption: s.caption,
      })),
    } : undefined,
  };
}

export async function POST(request: NextRequest) {
  let body: { manifestUrl?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { valid: false, errors: ['Invalid JSON body'] },
      { status: 400 }
    );
  }

  const { manifestUrl } = body;
  if (!manifestUrl || typeof manifestUrl !== 'string') {
    return NextResponse.json(
      { valid: false, errors: ['manifestUrl is required'] },
      { status: 400 }
    );
  }

  // Detect Gitea repo URLs and transform to raw manifest URL
  // Pattern: https://git.byka.wtf/{owner}/{repo} (with optional trailing slash)
  const giteaRepoPattern = /^https:\/\/git\.byka\.wtf\/([^/]+)\/([^/]+?)\/?$/;
  const giteaMatch = manifestUrl.match(giteaRepoPattern);
  const resolvedUrl = giteaMatch
    ? `https://git.byka.wtf/${giteaMatch[1]}/${giteaMatch[2]}/raw/branch/main/youeye-app.yaml`
    : manifestUrl;

  // Step 1: Validate URL safety
  const urlError = validateUrl(resolvedUrl);
  if (urlError) {
    return NextResponse.json(
      { valid: false, errors: [urlError] },
      { status: 400 }
    );
  }

  // Step 2: Fetch the YAML
  let yamlText: string;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(resolvedUrl, {
      signal: controller.signal,
      headers: {
        'Accept': 'text/yaml, application/yaml, text/plain, */*',
        'User-Agent': 'YouEye-AppMarket/1.0',
      },
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return NextResponse.json(
        { valid: false, errors: [`Failed to fetch manifest: HTTP ${res.status}`] },
        { status: 400 }
      );
    }

    // Check response size
    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_SIZE_BYTES) {
      return NextResponse.json(
        { valid: false, errors: ['Manifest file exceeds 1MB size limit'] },
        { status: 400 }
      );
    }

    yamlText = await res.text();

    if (yamlText.length > MAX_SIZE_BYTES) {
      return NextResponse.json(
        { valid: false, errors: ['Manifest file exceeds 1MB size limit'] },
        { status: 400 }
      );
    }
  } catch (err) {
    const message = err instanceof Error
      ? err.name === 'AbortError'
        ? 'Request timed out (5s limit)'
        : err.message
      : 'Failed to fetch manifest';

    return NextResponse.json(
      { valid: false, errors: [message] },
      { status: 400 }
    );
  }

  // Step 3: Parse YAML safely
  let raw: unknown;
  try {
    raw = parseYAML(yamlText, {
      // Safe parsing — no custom tags, no merge keys
      maxAliasCount: 0,
    });
  } catch (err) {
    return NextResponse.json(
      { valid: false, errors: [`Invalid YAML: ${err instanceof Error ? err.message : 'Parse error'}`] },
      { status: 400 }
    );
  }

  // Step 4: Validate against schema
  const result = AppManifestSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`
    );
    return NextResponse.json(
      { valid: false, errors },
      { status: 400 }
    );
  }

  // Step 5: Return validated manifest preview
  const manifest = result.data;
  const preview = manifestToPreview(manifest);

  // Log the URL install attempt for audit
  console.log(`[Market] Manifest validated from URL: ${resolvedUrl}${giteaMatch ? ` (repo: ${manifestUrl})` : ''} — app: ${manifest.metadata.id} v${manifest.version || 'unknown'}`);

  return NextResponse.json({
    valid: true,
    manifest: preview,
    capabilities: {
      sso: !!manifest.sso,
      sharedPostgres: manifest.database?.mode === 'shared',
      containers: manifest.containers.length,
      notifications: manifest.capabilities?.notifications,
      smtp: manifest.capabilities?.smtp,
    },
  });
}
