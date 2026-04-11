/**
 * POST /api/connectors/:connectorId/proxy — Execute a request through a connector
 *
 * Body:
 *   { endpoint: "search", params: { q: "Mars" }, lang: "en" }
 *
 * Headers:
 *   X-YouEye-App: ye-wiki
 *   X-YouEye-User: user-uuid
 */

import { NextResponse } from 'next/server';
import { executeProxy } from '@/lib/connectors/proxy';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ connectorId: string }> }
) {
  const { connectorId } = await params;
  const appId = request.headers.get('X-YouEye-App');
  const userId = request.headers.get('X-YouEye-User');

  if (!appId) {
    return NextResponse.json({ error: 'Missing X-YouEye-App header' }, { status: 400 });
  }

  let body: { endpoint?: string; params?: Record<string, unknown>; lang?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.endpoint) {
    return NextResponse.json({ error: 'Missing endpoint in request body' }, { status: 400 });
  }

  // Convert params to string values for template substitution
  const stringParams: Record<string, string | number | boolean | undefined> = {};
  if (body.params) {
    for (const [key, value] of Object.entries(body.params)) {
      if (value !== null && value !== undefined) {
        stringParams[key] = value as string | number | boolean;
      }
    }
  }

  const result = await executeProxy({
    connectorId,
    endpoint: body.endpoint,
    params: stringParams,
    lang: body.lang,
    // TODO: Fetch user config (API keys) from YE-UI user_connector_secrets
    // For now, connectors with auth: "none" (like Wikipedia) work without credentials
    userConfig: {},
  });

  if (!result.ok) {
    return NextResponse.json(result, { status: result.status });
  }

  return NextResponse.json(result);
}
