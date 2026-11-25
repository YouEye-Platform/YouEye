/**
 * After an uninstall: the apps that may still list the removed one, because a connection's `remove:` steps did
 * not run (YE-199). Read from the uninstall API's `connectionsLeft`; the Control Panel names each one, so the
 * admin knows where to remove the leftover by hand. An entry without `appId` means "a connected app".
 */
export interface ConnectionLeft {
  appId?: string;
  name?: string;
}

const MAX_SHOWN = 20;

export function connectionsLeftFrom(body: unknown): ConnectionLeft[] {
  if (!body || typeof body !== 'object') return [];
  const list = (body as { connectionsLeft?: unknown }).connectionsLeft;
  if (!Array.isArray(list)) return [];
  const left: ConnectionLeft[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { appId, name } = item as Record<string, unknown>;
    const entry: ConnectionLeft = typeof appId === 'string' && appId
      ? { appId, name: typeof name === 'string' && name.trim() ? name.trim() : appId }
      : {};
    if (!left.some((seen) => seen.appId === entry.appId)) left.push(entry);
  }
  return left.slice(0, MAX_SHOWN);
}
