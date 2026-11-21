/**
 * Bundle install-and-wire API.
 *
 * POST /api/market/bundles/[id]/install — install the bundle's members (skipping
 * already-installed ones) and auto-approve its declared connections. Streams progress as
 * Server-Sent Events (InstallEvent), with a final `done` event carrying the structured
 * BundleInstallResult in `detail`. Admin-gated by middleware (not in the public path list).
 *
 * `?source=<id>` names the bundle's Market source; without it the official Market's bundle is used. A custom source
 * must be accepted by the owner (403 otherwise); every member installs from that source.
 */

import { holdPlatformLifecycle, withUserOperationLockWait, type PlatformLifecycleHold } from '@/lib/market/update-admission';
import { lifecycleRefusalResponse } from '@/lib/http/lifecycle-busy';
import { NextRequest } from 'next/server';
import { fetchBundle } from '@/lib/market/catalog';
import { installBundle } from '@/lib/market/bundle-installer';
import { requireAdmin } from '@/lib/auth/rbac';
import { isMarketSourceConsentError, usableMarketSource } from '@/lib/market/source';
import type { InstallEvent } from '@/lib/market/types';
import { logOperationFailure, sensitivitySafeInstallError } from '@/lib/market/install-tracker';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const { id } = await params;
  const sourceId = request.nextUrl?.searchParams.get('source') || undefined;
  try {
    await usableMarketSource(sourceId);
  } catch (err) {
    if (isMarketSourceConsentError(err)) {
      return Response.json({ error: err.message, code: err.code }, { status: err.code === 'source-unavailable' ? 400 : 403 });
    }
    throw err;
  }

  // Held from here until every member has been installed: the bundle and its members are read from the market
  // between the members' installs, and Spine's Control Panel restart must wait for those reads as for the installs.
  let hold: PlatformLifecycleHold;
  try {
    hold = await withUserOperationLockWait(() => holdPlatformLifecycle());
  } catch (err) {
    logOperationFailure(`Admitting bundle ${id}`, err);
    return lifecycleRefusalResponse(err)
      ?? Response.json({ error: 'The bundle install could not start; the cause is in the Control Panel journal.' }, { status: 500 });
  }
  let streaming = false;
  try {
    return await hold.run(() => admittedBundleInstall(id, sourceId, hold, () => { streaming = true; }));
  } finally {
    if (!streaming) hold.release();
  }
}

/** The bundle install under its platform lifecycle hold; `streaming` hands the hold to the install's stream. */
async function admittedBundleInstall(
  id: string, sourceId: string | undefined, hold: PlatformLifecycleHold, streaming: () => void,
): Promise<Response> {
  let bundle;
  try {
    bundle = await fetchBundle(id, sourceId);
  } catch (err) {
    logOperationFailure(`Loading bundle ${id}`, err);
    return new Response(JSON.stringify({ error: 'The bundle could not be loaded' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!bundle) {
    return new Response(JSON.stringify({ error: `Bundle "${id}" not found` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const theBundle = bundle;

  const abortController = new AbortController();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: InstallEvent | Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // client closed the stream
        }
      };
      try {
        // A user operation: members' lifecycle and network locks wait for a busy holder instead of failing.
        const result = await hold.run(() => withUserOperationLockWait(() => installBundle(theBundle, (e) => send(e), abortController.signal)));
        const failed = result.members.some((m) => m.status === 'failed') || result.connections.some((c) => c.status === 'failed');
        send({ step: 0, totalSteps: 0, status: failed ? 'error' : 'success', message: failed ? 'done with failures' : 'done', detail: JSON.stringify(result) });
      } catch (err) {
        logOperationFailure(`Bundle ${theBundle.id} install`, err);
        send({ step: 0, totalSteps: 0, status: 'error', message: `Bundle install failed: ${sensitivitySafeInstallError(err)}` });
      } finally {
        hold.release();
        controller.close();
      }
    },
    cancel() {
      abortController.abort();
    },
  });
  streaming();

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
