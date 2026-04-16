import { NextResponse } from 'next/server';
import { validateAppToken } from '@/lib/apps/gateway-token';
import { getContainerIP } from '@/lib/incus/container-ip';

export async function POST(request: Request) {
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const identity = await validateAppToken(token);
  if (!identity) return NextResponse.json({ error: 'invalid token' }, { status: 401 });

  const widgets = await request.json();

  // Forward to UI via bridge
  try {
    const { readFileSync } = await import('fs');
    const bridgeToken = readFileSync('/etc/youeye/ui-bridge-token', 'utf-8').trim();
    const uiIP = await getContainerIP('youeye-ui');
    if (!uiIP) return NextResponse.json({ error: 'UI not available' }, { status: 503 });

    const res = await fetch(`http://${uiIP}:3000/api/v1/apps/${identity.appId}/widgets/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-UI-Bridge-Token': bridgeToken,
      },
      body: JSON.stringify(widgets),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return NextResponse.json({ error: 'UI sync failed', detail: text }, { status: res.status });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: 'Widget sync failed', detail: String(err) }, { status: 500 });
  }
}
