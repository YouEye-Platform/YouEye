/**
 * One answer for "another operation holds this app": user-facing routes run their work inside
 * withUserOperationLockWait (each lifecycle and network lock waits up to 30 s), and a lock still busy after that
 * becomes 409 "Another operation is in progress", never a 500.
 */
import { NextResponse } from 'next/server';
import { AppLifecycleBusyError } from '@/lib/market/update-admission';
import { AppNetworkLockBusyError } from '@/lib/incus/app-network-ipam';

export function isLifecycleBusy(error: unknown): boolean {
  return error instanceof AppLifecycleBusyError || error instanceof AppNetworkLockBusyError
    || (error instanceof Error && /executor lock is busy|AppLifecycleBusyError|AppNetworkLockBusyError/.test(`${error.name} ${error.message}`));
}

export function lifecycleBusyResponse(error: unknown): NextResponse | null {
  if (!isLifecycleBusy(error)) return null;
  return NextResponse.json({
    error: 'Another operation is in progress on this app. Try again in a moment.', code: 'operation_in_progress',
  }, { status: 409 });
}

/**
 * Run a user-facing route's work as a user operation: lifecycle and network locks wait up to 30 s; a lock still busy
 * becomes 409; any other failure is logged with its cause and answered with a plain 500 (never the raw error).
 */
export async function userOperationResponse(label: string, work: () => Promise<NextResponse>): Promise<NextResponse> {
  const { withUserOperationLockWait } = await import('@/lib/market/update-admission');
  const { logOperationFailure } = await import('@/lib/market/install-tracker');
  try {
    return await withUserOperationLockWait(work);
  } catch (error) {
    logOperationFailure(label, error);
    return lifecycleBusyResponse(error)
      ?? NextResponse.json({ error: `${label} failed; the cause is in the Control Panel journal.` }, { status: 500 });
  }
}
