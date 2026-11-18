/**
 * Bundle install-and-wire API.
 *
 * POST /api/market/bundles/[id]/install — install the bundle's members (skipping
 * already-installed ones) and auto-approve its declared connections. Streams progress as
 * Server-Sent Events (InstallEvent), with a final `done` event carrying the structured
 * BundleInstallResult in `detail`. Admin-gated by middleware (not in the public path list).
 */

import { withUserOperationLockWait } from '@/lib/market/update-admission';
import { NextRequest } from 'next/server';
import { fetchBundle } from '@/lib/market/catalog';
import { installBundle } from '@/lib/market/bundle-installer';
import { requireAdmin } from '@/lib/auth/rbac';
import type { InstallEvent } from '@/lib/market/types';
import { logOperationFailure, sensitivitySafeInstallError } from '@/lib/market/install-tracker';

export const dynamic = 'force-dynamic';

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const { id } = await params;

  let bundle;
  try {
    bundle = await fetchBundle(id);
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
        const result = await withUserOperationLockWait(() => installBundle(theBundle, (e) => send(e), abortController.signal));
        const failed = result.members.some((m) => m.status === 'failed') || result.connections.some((c) => c.status === 'failed');
        send({ step: 0, totalSteps: 0, status: failed ? 'error' : 'success', message: failed ? 'done with failures' : 'done', detail: JSON.stringify(result) });
      } catch (err) {
        logOperationFailure(`Bundle ${theBundle.id} install`, err);
        send({ step: 0, totalSteps: 0, status: 'error', message: `Bundle install failed: ${sensitivitySafeInstallError(err)}` });
      } finally {
        controller.close();
      }
    },
    cancel() {
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
