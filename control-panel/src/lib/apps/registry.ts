/**
 * App status utilities.
 */

import type { AppStatus } from '@/types/apps';

/**
 * Parse container status string to AppStatus enum.
 */
export function containerStatusToAppStatus(containerStatus: string | undefined): AppStatus {
  if (!containerStatus) return 'not-installed';
  switch (containerStatus.toLowerCase()) {
    case 'running':
      return 'running';
    case 'stopped':
    case 'frozen':
      return 'stopped';
    case 'error':
      return 'error';
    default:
      return 'stopped';
  }
}
