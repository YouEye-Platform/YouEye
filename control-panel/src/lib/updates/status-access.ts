export interface UpdateStatusSession {
  isAdmin?: boolean;
}

export type UpdateStatusAccess =
  | { allowed: true }
  | { allowed: false; status: 401 | 403; error: string };

export function checkUpdateStatusAccess(
  session: UpdateStatusSession | null | undefined,
): UpdateStatusAccess {
  if (!session) return { allowed: false, status: 401, error: 'Unauthorized' };
  if (!session.isAdmin) return { allowed: false, status: 403, error: 'Admin access required' };
  return { allowed: true };
}
