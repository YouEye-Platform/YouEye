/**
 * GET /api/v1/connectors/list — List available connectors
 *
 * One-Way Bridge: Fetches directly from Gitea via local registry,
 * bypassing CP entirely.
 */

import { NextResponse } from "next/server";
import { listConnectors } from "@/lib/connectors/registry";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const capability = url.searchParams.get("capability") ?? undefined;

  try {
    const manifests = await listConnectors(capability);
    const connectors = manifests.map((m) => ({
      id: m.metadata.id,
      name: m.metadata.name,
      icon: m.metadata.icon,
      description: m.metadata.description,
      provides: m.metadata.provides,
      network: m.metadata.network,
      authMethod: m.permissions.auth.method,
      configFields: m.config.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        required: f.required,
        helpText: f.helpText,
        helpUrl: f.helpUrl,
      })),
    }));

    return NextResponse.json({ connectors });
  } catch {
    return NextResponse.json({ error: "Registry unreachable" }, { status: 502 });
  }
}
