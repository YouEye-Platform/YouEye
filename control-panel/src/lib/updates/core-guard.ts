import { spineClient, type CoreUpdateStatus } from '../spine/client';

export async function readCoreUpdateStatus(): Promise<CoreUpdateStatus> {
  return spineClient.getCoreUpdateStatus();
}
