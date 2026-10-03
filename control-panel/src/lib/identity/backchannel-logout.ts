import { createLogoutToken } from './tokens';
import { getIdentityConfig } from './config';
import { getContainerIP } from '@/lib/incus/container-ip';
import { readInstallMetadata } from '@/lib/market/metadata';
import {
  enqueueLogoutDelivery,
  finishLogoutDelivery,
  getDueLogoutDeliveries,
  getClient,
  listSessionLogoutClients,
  listUserLogoutSessions,
} from './store';

let delivering = false;

export async function queueSessionLogout(sessionId: string): Promise<number> {
  const clients = await listSessionLogoutClients(sessionId);
  for (const client of clients) {
    const token = await createLogoutToken(client.client_id, client.user_id, sessionId);
    await enqueueLogoutDelivery({ sessionId, clientId: client.client_id, uri: client.uri, token });
  }
  return clients.length;
}

export async function queueUserLogout(userId: string): Promise<number> {
  const sessions = await listUserLogoutSessions(userId);
  let queued = 0;
  for (const session of sessions) queued += await queueSessionLogout(session.id);
  return queued;
}

export async function deliverDueLogouts(): Promise<void> {
  if (delivering) return;
  delivering = true;
  try {
    for (const delivery of await getDueLogoutDeliveries()) {
      let delivered = false;
      try {
        const participants = await listSessionLogoutClients(delivery.session_id);
        if (!participants.some((participant) => participant.client_id === delivery.client_id && participant.uri === delivery.uri)) {
          await finishLogoutDelivery(delivery.id, true);
          continue;
        }
        // Reconfiguration or uninstall may remove or change a destination while
        // notifications wait in the durable queue. Never POST to a stale URL.
        const current = await getClient(delivery.client_id);
        if (!current || current.backchannel_logout_uri !== delivery.uri) {
          await finishLogoutDelivery(delivery.id, true);
          continue;
        }
        const destination = new URL(delivery.uri);
        const config = await getIdentityConfig();
        const managedHost = destination.hostname === config.domain || destination.hostname.endsWith(`.${config.domain}`);
        if (destination.username || destination.password || destination.hash || destination.search
          || (destination.protocol === 'https:' && (!managedHost || Boolean(destination.port)))
          || (destination.protocol !== 'https:' && !(destination.protocol === 'http:'
          && destination.hostname === `app-${delivery.client_id.slice('youeye-app-'.length)}.youeye`
          && destination.port === '3000' && delivery.client_id.startsWith('youeye-app-')))) {
          await finishLogoutDelivery(delivery.id, true);
          continue;
        }
        let deliveryUrl = delivery.uri;
        if (delivery.client_id.startsWith('youeye-app-') && destination.protocol === 'https:') {
          const appId = delivery.client_id.slice('youeye-app-'.length);
          const metadata = await readInstallMetadata(appId);
          if (!metadata || destination.hostname !== `${metadata.subdomain}.${metadata.domain}`) {
            await finishLogoutDelivery(delivery.id, true);
            continue;
          }
          const container = metadata.containers?.find(item => item.primary) || metadata.containers?.[0];
          if (!container) throw new Error('Managed app has no primary container');
          const ip = await getContainerIP(container.containerName);
          if (!ip) throw new Error('Managed app is not reachable');
          deliveryUrl = `http://${ip}:${container.port || 3000}${destination.pathname}`;
        }
        const response = await fetch(deliveryUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ logout_token: delivery.logout_token }),
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(5_000),
        });
        delivered = response.status === 204;
      } catch { /* Retry persisted delivery later. */ }
      await finishLogoutDelivery(delivery.id, delivered);
    }
  } finally {
    delivering = false;
  }
}
