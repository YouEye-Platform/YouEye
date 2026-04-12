/**
 * Webhook Management API
 *
 * GET    /api/settings/webhooks — List all webhooks
 * POST   /api/settings/webhooks — Create a webhook
 * DELETE  /api/settings/webhooks — Delete a webhook (pass { id } in body)
 * PUT    /api/settings/webhooks — Update a webhook (pass { id, ...updates } in body)
 *
 * Admin only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
} from '@/lib/events/emitter';
import type { PlatformEventType } from '@/lib/events/emitter';

const VALID_EVENTS: PlatformEventType[] = [
  'app.installed',
  'app.uninstalled',
  'app.updated',
  'user.created',
  'user.login',
  'settings.changed',
  'backup.completed',
  'backup.failed',
  'system.health.changed',
];

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const webhooks = await listWebhooks();
  // Don't expose secrets in list response
  const safe = webhooks.map(({ secret, ...rest }) => ({
    ...rest,
    hasSecret: !!secret,
  }));

  return NextResponse.json({ webhooks: safe });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { url, events, description } = body;

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'Missing or invalid url' }, { status: 400 });
    }

    if (!Array.isArray(events) || events.length === 0) {
      return NextResponse.json({ error: 'Must specify at least one event' }, { status: 400 });
    }

    // Validate event types
    for (const evt of events) {
      if (!VALID_EVENTS.includes(evt)) {
        return NextResponse.json(
          { error: `Invalid event type: ${evt}. Valid: ${VALID_EVENTS.join(', ')}` },
          { status: 400 }
        );
      }
    }

    const webhook = await createWebhook({
      url,
      events,
      enabled: true,
      description,
    });

    return NextResponse.json({
      webhook: {
        id: webhook.id,
        url: webhook.url,
        secret: webhook.secret, // Only returned on creation
        events: webhook.events,
        enabled: webhook.enabled,
        description: webhook.description,
        createdAt: webhook.createdAt,
      },
    }, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json({ error: 'Missing webhook id' }, { status: 400 });
    }

    if (updates.events) {
      for (const evt of updates.events) {
        if (!VALID_EVENTS.includes(evt)) {
          return NextResponse.json(
            { error: `Invalid event type: ${evt}` },
            { status: 400 }
          );
        }
      }
    }

    const updated = await updateWebhook(id, updates);
    if (!updated) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
    }

    return NextResponse.json({ webhook: { ...updated, secret: undefined } });
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { id } = body;

    if (!id) {
      return NextResponse.json({ error: 'Missing webhook id' }, { status: 400 });
    }

    const deleted = await deleteWebhook(id);
    if (!deleted) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}
