/**
 * GET /api/connectors — List available connectors
 * GET /api/connectors?capability=encyclopedia — Filter by capability
 */

import { NextResponse } from 'next/server';
import { listConnectors } from '@/lib/connectors/registry';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const capability = url.searchParams.get('capability') ?? undefined;

    const manifests = await listConnectors(capability);

    const connectors = manifests.map((m) => ({
      id: m.metadata.id,
      name: m.metadata.name,
      description: m.metadata.description,
      icon: m.metadata.icon,
      provides: m.metadata.provides,
      capability: Array.isArray(m.metadata.provides) ? m.metadata.provides[0] : m.metadata.provides,
      network: m.metadata.network,
      authMethod: m.permissions.auth.method,
      configFields: m.config.fields,
      endpoints: Object.keys(m.api.endpoints),
      allowedHosts: m.permissions.network.allowedHosts,
    }));

    return NextResponse.json({ connectors });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list connectors';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
