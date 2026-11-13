import { spineClient, type CoreUpdateStatus } from '../spine/client';

export async function readCoreUpdateStatus(): Promise<CoreUpdateStatus> {
  return spineClient.getCoreUpdateStatus();
}

/** The installed host owns core mutation authority, including direct UI calls. */
export async function assertIndependentCoreUpdate(component: string): Promise<void> {
  if (!['spine', 'control', 'ui', 'system', 'host-system'].includes(component)) return;
  if ((await readCoreUpdateStatus()).managed) {
    throw new Error('This installation uses one complete System release; update the complete core selection.');
  }
}
