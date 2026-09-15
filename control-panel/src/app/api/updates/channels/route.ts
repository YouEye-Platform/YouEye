import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth/session';
import { spineClient } from '@/lib/spine/client';
import { settingsService } from '@/lib/settings';
import {
  effectiveChannel,
  resolveCandidate,
  getReleaseChannelsConfig,
  APP_PREFIX,
  type Channel,
  type EffectiveChannel,
} from '@/lib/updates/channels';
import { formatVersion } from '@/lib/version';
import { getAllInstalledApps } from '@/lib/market/installed-apps';
import { getCoreProvenance } from '@/lib/updates/provenance';
import { APP_DEFINITIONS } from '@/lib/apps/definitions';
import { checkLxdAppUpdate } from '@/lib/apps/lxd-updates';

/**
 * GET /api/updates/channels
 * PUT /api/updates/channels
 *
 * Per-component release-channel management. GET returns the effective channel,
 * the raw override (or null), installed/candidate refs, and update/switch flags
 * for every component: default, spine, control, ui, and each installed native
 * app ("app:<id>"). PUT proxies channel edits to Spine (single writer) via
 * patchConfig({ release_channels: … }).
 */

interface VersionRef {
  version: string | null;
  branch: string | null;
  tag: string | null;
}

interface ComponentEntry {
  channel: EffectiveChannel;
  override: Channel | null;
  installed: VersionRef;
  candidate: VersionRef;
  update_available: boolean;
  switch_pending: boolean;
}

function pickOverrideRaw(raw: Record<string, unknown>, component: string): Channel | null {
  const rc = raw.release_channels;
  if (!rc || typeof rc !== 'object') return null;
  const cfg = rc as Record<string, unknown>;
  if (component.startsWith(APP_PREFIX)) {
    const appId = component.slice(APP_PREFIX.length);
    const apps = cfg.apps as Record<string, Channel> | undefined;
    return apps?.[appId] ?? null;
  }
  return (cfg[component] as Channel | undefined) ?? null;
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  try {
    const config = await getReleaseChannelsConfig();
    const raw = await settingsService.getRaw();
    const components: Record<string, ComponentEntry> = {};

    // Spine + control: provenance + candidate come from Spine's channel-aware
    // /api/updates/check (CP does not resolve core releases itself).
    let spineCheck: Awaited<ReturnType<typeof spineClient.checkUpdates>> | null = null;
    try {
      spineCheck = await spineClient.checkUpdates();
    } catch (err) {
      console.warn('[channels] spine updates/check unavailable:', err);
    }

    // default
    components.default = {
      channel: await effectiveChannel('default', { config }),
      override: config.default ?? null,
      installed: { version: null, branch: null, tag: null },
      candidate: { version: null, branch: null, tag: null },
      update_available: false,
      switch_pending: false,
    };

    for (const core of ['spine', 'control'] as const) {
      const chk = spineCheck?.[core];
      components[core] = {
        channel: await effectiveChannel(core, { config }),
        override: pickOverrideRaw(raw, core),
        installed: {
          version: chk?.installed?.version ?? chk?.current ?? null,
          branch: chk?.installed?.branch ?? null,
          tag: chk?.installed?.tag ?? null,
        },
        candidate: {
          version: chk?.candidate?.version ?? chk?.latest ?? null,
          branch: chk?.candidate?.branch ?? null,
          tag: chk?.candidate?.tag ?? null,
        },
        update_available: chk?.update_available ?? chk?.available ?? false,
        switch_pending: chk?.switch_pending ?? false,
      };
    }

    // ui: CP owns provenance + resolves the candidate via the ui channel.
    {
      const uiChannel = await effectiveChannel('ui', { config });
      const prov = await getCoreProvenance('ui');
      let candidate = null;
      try {
        candidate = await resolveCandidate(uiChannel, 'ui', uiChannel.source);
      } catch (err) {
        console.warn('[channels] ui candidate resolution failed:', err);
      }
      const installedBranch = prov?.branch || 'main';
      const switchPending = !!candidate && candidate.branch !== installedBranch;
      components.ui = {
        channel: uiChannel,
        override: pickOverrideRaw(raw, 'ui'),
        installed: { version: prov?.version ?? null, branch: prov?.branch ?? null, tag: prov?.tag ?? null },
        candidate: candidate
          ? { version: candidate.version, branch: candidate.branch, tag: candidate.tag }
          : { version: null, branch: null, tag: null },
        update_available: !!candidate && !switchPending
          && (!prov?.version || candidate.version !== prov.version),
        switch_pending: switchPending,
      };
    }

    // Statically defined native apps (Pointer today) participate in the same
    // app:<id> channel contract as Market-installed native apps.
    const staticChannelKeys = new Set<string>();
    for (const appDef of APP_DEFINITIONS) {
      const key = appDef.releaseChannelKey;
      if (!key || !appDef.lxdConfig) continue;
      staticChannelKeys.add(key);
      const [result, provenance] = await Promise.all([
        checkLxdAppUpdate(appDef, true),
        getCoreProvenance(key),
      ]);
      const ch = await effectiveChannel(key, { config, appDefaultSource: result.source });
      const installedVersion = provenance?.version ?? result.installedVersion ?? null;
      const candidateVersion = result.latestVersion ?? null;
      const installedBranch = provenance?.branch ?? 'main';
      const switchPending = !!candidateVersion && (
        result.latestBranch !== installedBranch ||
        (!!provenance?.tag && result.latestTag !== provenance.tag && candidateVersion === installedVersion)
      );
      components[key] = {
        channel: ch,
        override: pickOverrideRaw(raw, key),
        installed: {
          version: installedVersion,
          branch: provenance?.branch ?? null,
          tag: provenance?.tag ?? null,
        },
        candidate: {
          version: candidateVersion,
          branch: result.latestBranch ?? null,
          tag: result.latestTag ?? null,
        },
        update_available: !!candidateVersion && !switchPending && candidateVersion !== installedVersion,
        switch_pending: switchPending,
      };
    }

    // Native apps: one entry per installed app, keyed "app:<id>".
    const installedApps = await getAllInstalledApps();
    for (const app of installedApps) {
      if (app.type === 'market') continue; // OCI/market apps keep market-source selection
      const key = APP_PREFIX + app.appId;
      if (staticChannelKeys.has(key)) continue;
      const appDefaultSource = app.channelSource || app.sourceRepoUrl || undefined;
      const ch = await effectiveChannel(key, { config, appDefaultSource });
      components[key] = {
        channel: ch,
        override: pickOverrideRaw(raw, key),
        installed: {
          version: app.installedVersion || null,
          branch: app.installedBranch ?? null,
          tag: app.installedTag ?? null,
        },
        candidate: {
          version: app.candidateVersion ?? app.catalogVersion ?? null,
          branch: app.candidateBranch ?? null,
          tag: app.candidateTag ?? null,
        },
        update_available: app.updateAvailable,
        switch_pending: !!app.switchPending,
      };
    }

    // Attach trimmed display strings for convenience (UI still formats defensively).
    const withDisplay = Object.fromEntries(
      Object.entries(components).map(([id, entry]) => [
        id,
        {
          ...entry,
          installed_display: entry.installed.version ? formatVersion(entry.installed.version) : null,
          candidate_display: entry.candidate.version ? formatVersion(entry.candidate.version) : null,
        },
      ]),
    );

    return NextResponse.json({ components: withDisplay });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[channels] GET failed:', error);
    return NextResponse.json({ error: `Failed to read channels: ${msg}` }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!(await verifyCSRFToken(csrfToken ?? ''))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

  if (!session.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  let body: Record<string, Channel | null>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Body must be a map of component -> channel|null' }, { status: 400 });
  }

  // Validate component ids + channel shapes before proxying to Spine.
  const validComponent = (id: string) =>
    id === 'default' || id === 'spine' || id === 'control' || id === 'ui' || id.startsWith(APP_PREFIX);
  for (const [id, ch] of Object.entries(body)) {
    if (!validComponent(id)) {
      return NextResponse.json({ error: `Unknown component "${id}"` }, { status: 400 });
    }
    if (ch !== null) {
      if (typeof ch !== 'object' || Array.isArray(ch)) {
        return NextResponse.json({ error: `Channel for "${id}" must be an object or null` }, { status: 400 });
      }
      if (ch.branch !== undefined && typeof ch.branch !== 'string') {
        return NextResponse.json({ error: `branch for "${id}" must be a string` }, { status: 400 });
      }
      if (ch.source !== undefined && typeof ch.source !== 'string') {
        return NextResponse.json({ error: `source for "${id}" must be a string` }, { status: 400 });
      }
      if (ch.tag !== undefined && typeof ch.tag !== 'string') {
        return NextResponse.json({ error: `tag for "${id}" must be a string` }, { status: 400 });
      }
      if (ch.artifact_sha256 !== undefined && (typeof ch.artifact_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(ch.artifact_sha256))) {
        return NextResponse.json({ error: `artifact_sha256 for "${id}" must be 64 lowercase hexadecimal characters` }, { status: 400 });
      }
      if (ch.fallback !== undefined && !Array.isArray(ch.fallback)) {
        return NextResponse.json({ error: `fallback for "${id}" must be an array` }, { status: 400 });
      }
    }
  }

  try {
    // Spine is the single writer — proxy through patchConfig. null clears the
    // component's override (spine merges per-component).
    await settingsService.setReleaseChannels(body);
    return NextResponse.json({ status: 'updated' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[channels] PUT failed:', error);
    return NextResponse.json({ error: `Failed to update channels: ${msg}` }, { status: 500 });
  }
}
