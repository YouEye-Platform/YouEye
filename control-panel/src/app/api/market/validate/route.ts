/**
 * POST /api/market/validate
 *
 * Pre-install validation. Accepts either an appId (from the catalog) or the app source
 * (`manifest`: youeye-app.yaml text, optional `setups`: setup file name → text) and
 * returns a structured report from the one app-format validator.
 *
 * Admin only: the report checks that every image exists, which makes the box reach the registries the manifest
 * names (a blind request to any address for whoever may call it). Nothing but the admin tooling calls it.
 */

import { NextResponse } from 'next/server';
import { requireAdminCsrf } from '@/lib/auth/rbac';
import { validateManifest } from '@/lib/market/validator';

export async function POST(request: Request) {
  const auth = await requireAdminCsrf(request);
  if (auth.error) return auth.error;
  try {
    const body = await request.json();
    const { appId, sourceId, manifest: manifestText, setups, subdomain } = body as {
      appId?: string;
      sourceId?: string;
      manifest?: unknown;
      setups?: unknown;
      subdomain?: string;
    };

    let source: { manifest: string; setups?: Record<string, string> };

    if (typeof manifestText === 'string') {
      const setupTexts = setups && typeof setups === 'object' && !Array.isArray(setups)
        && Object.values(setups).every((text) => typeof text === 'string')
        ? setups as Record<string, string> : undefined;
      if (setups !== undefined && !setupTexts) {
        return NextResponse.json({ error: 'setups maps setup file names to text' }, { status: 400 });
      }
      source = { manifest: manifestText, setups: setupTexts };
    } else if (appId) {
      // The catalog app's source text
      const { fetchManifestFromSource } = await import('@/lib/market/catalog');
      const frozen = (await fetchManifestFromSource(appId, sourceId)).frozen;
      if (!frozen) return NextResponse.json({ error: 'App source is unavailable' }, { status: 404 });
      source = { manifest: frozen.manifest, setups: frozen.setups };
    } else {
      return NextResponse.json({ error: 'Provide appId or manifest (youeye-app.yaml text)' }, { status: 400 });
    }

    const report = await validateManifest(source, {
      checkImages: true,
      checkSubdomain: subdomain,
    });

    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json(
      { error: 'Validation failed', detail: String(err) },
      { status: 500 }
    );
  }
}
