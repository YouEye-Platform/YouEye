/**
 * Suggestions API
 *
 * GET  /api/suggestions — list active suggestions
 * POST /api/suggestions — actions: dismiss, remove, approve
 */

import { NextResponse } from 'next/server';
import { listSuggestions, dismissSuggestion, removeSuggestion } from '@/lib/bridges/suggestions';
import { createBridge, activateBridge, resolveBridgeMappings, detectBridgeDependencies } from '@/lib/bridges/manager';
import { updateBridge } from '@/lib/bridges/store';
import { readInstallMetadata } from '@/lib/market/metadata';
import { fetchManifest } from '@/lib/market/catalog';
import { settingsService } from '@/lib/settings';

export async function GET() {
  const suggestions = await listSuggestions();
  return NextResponse.json(suggestions);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { action, id, suggestionId } = body;
  const sid = id || suggestionId;

  if (!sid) {
    return NextResponse.json({ error: 'id or suggestionId is required' }, { status: 400 });
  }

  if (action === 'dismiss') {
    await dismissSuggestion(sid);
    return NextResponse.json({ ok: true });
  }

  if (action === 'remove') {
    await removeSuggestion(sid);
    return NextResponse.json({ ok: true });
  }

  if (action === 'approve') {
    // Find the suggestion
    const all = await listSuggestions(true);
    const suggestion = all.find(s => s.id === sid);
    if (!suggestion) {
      return NextResponse.json({ error: 'Suggestion not found' }, { status: 404 });
    }

    if (suggestion.type !== 'bridge' || !suggestion.targetAppId) {
      return NextResponse.json({ error: 'Only bridge suggestions can be approved' }, { status: 400 });
    }

    try {
      // Build env mappings from manifest
      let envMappings: { container: string; key: string; template: string }[] = [];
      try {
        const manifest = await fetchManifest(suggestion.fromAppId);
        if (manifest.env_mapping) {
          envMappings = detectBridgeDependencies(manifest.env_mapping, suggestion.fromAppId)
            .filter(d => d.targetAppId === suggestion.targetAppId)
            .flatMap(d => d.envMappings);
        }
      } catch {
        // Proceed without env mappings
      }

      const bridge = await createBridge({
        from: suggestion.fromAppId,
        to: suggestion.targetAppId,
        envMappings,
        approvedBy: 'settings',
      });

      // If target is installed, resolve and activate
      const targetMeta = await readInstallMetadata(suggestion.targetAppId);
      if (targetMeta) {
        const targetContainer = targetMeta.containers?.[0]?.containerName || `app-${suggestion.targetAppId}`;
        const targetSub = targetMeta.subdomain || suggestion.targetAppId;
        const config = await settingsService.getRaw();
        if (!config.domain) {
          return NextResponse.json({ error: 'Domain not configured in settings' }, { status: 500 });
        }
        const domain = config.domain;

        // Get target port from manifest wants
        let targetPort = 8080;
        try {
          const manifest = await fetchManifest(suggestion.fromAppId);
          const want = manifest.wants?.find((w: { appId: string }) => w.appId === suggestion.targetAppId);
          if (want?.defaultPort) targetPort = want.defaultPort;
        } catch { /* use default */ }

        const resolved = await resolveBridgeMappings(envMappings, targetContainer, targetPort, targetSub, domain);
        await updateBridge(bridge.id, { envMappings: resolved });
        await activateBridge(bridge.id);
      }

      // Remove the suggestion
      await removeSuggestion(sid);
      return NextResponse.json({ ok: true, bridgeId: bridge.id });
    } catch (err) {
      return NextResponse.json({ error: `Failed to approve: ${err}` }, { status: 500 });
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
