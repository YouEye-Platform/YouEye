/**
 * In-memory tracker for in-flight installations.
 * Allows clients to reconnect, check status, and cancel installs.
 */

import type { InstallEvent } from './types';

interface TrackedInstall {
  appId: string;
  appName: string;
  events: InstallEvent[];
  done: boolean;
  startedAt: number;
  error?: string;
  cancelled?: boolean;
  abortController?: AbortController;
}

const activeInstalls = new Map<string, TrackedInstall>();

export function startTracking(appId: string, appName: string): AbortController {
  const abortController = new AbortController();
  activeInstalls.set(appId, {
    appId,
    appName,
    events: [],
    done: false,
    startedAt: Date.now(),
    abortController,
  });
  return abortController;
}

export function trackEvent(appId: string, event: InstallEvent): void {
  const install = activeInstalls.get(appId);
  if (!install) return;
  // Update existing running event or add new
  const existingIdx = install.events.findIndex(e => e.step === event.step && e.status === 'running');
  if (existingIdx >= 0 && event.status !== 'running') {
    install.events[existingIdx] = event;
  } else {
    install.events.push(event);
  }
}

export function finishTracking(appId: string, error?: string): void {
  const install = activeInstalls.get(appId);
  if (!install) return;
  install.done = true;
  install.error = error;
  delete install.abortController;
  // Auto-cleanup after 5 minutes
  setTimeout(() => activeInstalls.delete(appId), 5 * 60 * 1000);
}

export function cancelInstall(appId: string): boolean {
  const install = activeInstalls.get(appId);
  if (!install || install.done) return false;
  install.cancelled = true;
  install.abortController?.abort();
  return true;
}

export function getTrackedInstall(appId: string): Omit<TrackedInstall, 'abortController'> | undefined {
  const install = activeInstalls.get(appId);
  if (!install) return undefined;
  const { abortController: _, ...rest } = install;
  return rest;
}

export function getAllActiveInstalls(): Omit<TrackedInstall, 'abortController'>[] {
  return Array.from(activeInstalls.values()).map(({ abortController: _, ...rest }) => rest);
}

export function isInstalling(appId: string): boolean {
  const install = activeInstalls.get(appId);
  return install !== undefined && !install.done;
}
