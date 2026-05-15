/**
 * App Types
 * 
 * Type definitions for Spine-deployed apps.
 * Control Panel manages these apps but does not install them.
 */

import type { AppManifest } from '@/lib/apps/manifest';

/**
 * App installation status
 */
export type AppStatus = 
  | 'not-installed'
  | 'running'
  | 'stopped'
  | 'error';

/**
 * App instance with runtime information
 */
export interface AppInstance {
  /** The app manifest */
  manifest: AppManifest;
  /** Current status */
  status: AppStatus;
  /** Container status details if installed */
  containerStatus?: {
    status: string;
    statusCode: number;
    ipv4?: string;
    uptime?: string;
  };
  /** Last error message if any */
  error?: string;
}

/**
 * App control actions
 */
export type AppAction = 'start' | 'stop' | 'restart' | 'remove';

/**
 * App control request
 */
export interface AppControlRequest {
  action: AppAction;
  force?: boolean;
}
