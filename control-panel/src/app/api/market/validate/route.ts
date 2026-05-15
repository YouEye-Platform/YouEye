/**
 * POST /api/market/validate
 *
 * Pre-install manifest validation. Accepts either an appId (from catalog)
 * or raw manifest YAML, runs the 8-check validation pipeline, and returns
 * a structured report.
 */

import { NextResponse } from 'next/server';
import { validateManifest } from '@/lib/market/validator';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { appId, manifest: rawManifest, subdomain } = body as {
      appId?: string;
      manifest?: unknown;
      subdomain?: string;
    };

    let manifestData: unknown;

    if (rawManifest) {
      // Direct manifest object passed
      manifestData = rawManifest;
    } else if (appId) {
      // Fetch from catalog by appId
      const { fetchManifest } = await import('@/lib/market/catalog');
      manifestData = await fetchManifest(appId);
    } else {
      return NextResponse.json({ error: 'Provide appId or manifest' }, { status: 400 });
    }

    const report = await validateManifest(manifestData, {
      checkImages: true,
      checkUrls: true,
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
