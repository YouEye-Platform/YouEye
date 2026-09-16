import { spineClient } from '@/lib/spine/client';
import { getSystemUpdateSelection } from './system-update-source';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 90 * 1000;
const MUTABLE_STATES = new Set(['healthy', 'rolled-back']);
let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export async function checkForSystemUpdate(): Promise<void> {
  const runtime = await spineClient.status();
  if (runtime.runtime.kind !== 'appliance-image' || !runtime.runtime.capabilities.image_update) return;
  const status = await spineClient.getApplianceSystemUpdateStatus();
  if (!MUTABLE_STATES.has(status.state)) return;
  const selection = await getSystemUpdateSelection();
  if (selection.channel === 'exact') return;
  await spineClient.checkApplianceSystemUpdate(selection);
}

export function startSystemUpdateChecker(): void {
  if (timer || initialTimer) return;
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void checkForSystemUpdate().catch((error) => {
      console.warn('[system-update-checker] Initial metadata check failed:', error);
    });
  }, INITIAL_DELAY_MS);
  timer = setInterval(() => {
    void checkForSystemUpdate().catch((error) => {
      console.warn('[system-update-checker] Periodic metadata check failed:', error);
    });
  }, CHECK_INTERVAL_MS);
}

export function stopSystemUpdateChecker(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
