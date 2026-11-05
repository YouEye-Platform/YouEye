/**
 * UI Bridge: DNS Domain Lists
 *
 * GET    /api/ui-bridge/dns/domains — list exact + regex allow/deny domains
 * POST   /api/ui-bridge/dns/domains — add a domain to a list
 * DELETE /api/ui-bridge/dns/domains — remove a domain from a list
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { getDomainLists, piholeRequest } from '@/lib/apps/pihole-api';

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const exactLists = await getDomainLists();

    const allowRegexData = await piholeRequest<{ domains: Array<{ domain: string }> }>('/api/domains/allow/regex').catch(() => ({ domains: [] }));
    const denyRegexData = await piholeRequest<{ domains: Array<{ domain: string }> }>('/api/domains/deny/regex').catch(() => ({ domains: [] }));

    return NextResponse.json({
      allow: {
        exact: exactLists.whitelist,
        regex: (allowRegexData.domains || []).map(d => d.domain),
      },
      deny: {
        exact: exactLists.blacklist,
        regex: (denyRegexData.domains || []).map(d => d.domain),
      },
    });
  } catch (err) {
    console.error('[UI Bridge] DNS domains GET error:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve domain lists' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { domain, list, kind } = body as {
      domain: string;
      list: 'allow' | 'deny';
      kind: 'exact' | 'regex';
    };

    if (!domain || !list || !kind) {
      return NextResponse.json(
        { error: 'Missing required fields: domain, list, kind' },
        { status: 400 }
      );
    }

    if (!['allow', 'deny'].includes(list) || !['exact', 'regex'].includes(kind)) {
      return NextResponse.json(
        { error: 'list must be "allow"|"deny", kind must be "exact"|"regex"' },
        { status: 400 }
      );
    }

    await piholeRequest(`/api/domains/${list}/${kind}`, {
      method: 'POST',
      body: JSON.stringify({ domain }),
    });

    console.log(`[UI Bridge] Added domain "${domain}" to ${list}/${kind}`);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[UI Bridge] DNS domains POST error:', err);
    return NextResponse.json(
      { error: 'Failed to add domain' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { domain, list, kind } = body as {
      domain: string;
      list: 'allow' | 'deny';
      kind: 'exact' | 'regex';
    };

    if (!domain || !list || !kind) {
      return NextResponse.json(
        { error: 'Missing required fields: domain, list, kind' },
        { status: 400 }
      );
    }

    if (!['allow', 'deny'].includes(list) || !['exact', 'regex'].includes(kind)) {
      return NextResponse.json(
        { error: 'list must be "allow"|"deny", kind must be "exact"|"regex"' },
        { status: 400 }
      );
    }

    await piholeRequest(
      `/api/domains/${list}/${kind}/${encodeURIComponent(domain)}`,
      { method: 'DELETE' }
    );

    console.log(`[UI Bridge] Removed domain "${domain}" from ${list}/${kind}`);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[UI Bridge] DNS domains DELETE error:', err);
    return NextResponse.json(
      { error: 'Failed to remove domain' },
      { status: 500 }
    );
  }
}
