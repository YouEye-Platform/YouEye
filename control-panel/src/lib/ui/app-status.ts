import { readFileSync } from 'fs';
import { getContainerIP } from '@/lib/incus/container-ip';

const UI_CONTAINER = 'youeye-ui';
const BRIDGE_TOKEN_PATH = '/etc/youeye/ui-bridge-token';

let bridgeTokenCache: string | null | undefined;

function readBridgeToken(): string | null {
  if (bridgeTokenCache !== undefined) return bridgeTokenCache;
  try {
    const token = readFileSync(BRIDGE_TOKEN_PATH, 'utf-8').trim();
    bridgeTokenCache = token || null;
  } catch (error) {
    console.warn('[ui-app-status] Could not read UI bridge token:', error);
    bridgeTokenCache = null;
  }
  return bridgeTokenCache;
}

export async function pushAppRuntimeStatusToUI(
  appId: string,
  status: 'healthy' | 'unhealthy' | 'unknown' | 'stopped',
): Promise<boolean> {
  const uiIP = await getContainerIP(UI_CONTAINER);
  const bridgeToken = readBridgeToken();
  if (!uiIP || !bridgeToken) return false;

  try {
    const response = await fetch(`http://${uiIP}:3000/api/v1/apps/${encodeURIComponent(appId)}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-UI-Bridge-Token': bridgeToken,
      },
      body: JSON.stringify({ status }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(`[ui-app-status] UI status push failed for ${appId}: ${response.status} ${body}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`[ui-app-status] UI status push failed for ${appId}:`, error);
    return false;
  }
}
