export interface PointerIdentityChange { oldIssuer: string; newIssuer: string }

/** Keep the identity transition and the platform's routing/configuration change together. */
export async function changePointerIdentity(
  change: PointerIdentityChange,
  operations: {
    transition: (change: PointerIdentityChange, checkOnly: boolean) => Promise<'ready' | 'changed' | 'already-applied'>;
    apply: () => Promise<void>;
    restore: () => Promise<void>;
    start: () => Promise<void>;
  },
): Promise<void> {
  // The caller also preflights before its first mutation. Recheck at the write boundary.
  await operations.transition(change, true);
  let transitionAttempted = false;
  try {
    await operations.apply();
    transitionAttempted = true;
    await operations.transition(change, false);
    await operations.start();
  } catch (failure) {
    // A failed exec response may have committed. Read-only checks distinguish that case
    // from an unchanged database before attempting the exact reverse transition.
    try {
      await operations.restore();
      if (transitionAttempted) {
        if (await operations.transition(change, true) === 'already-applied') {
          await operations.transition({ oldIssuer: change.newIssuer, newIssuer: change.oldIssuer }, false);
        }
      }
      await operations.start();
    } catch {
      throw new Error('Domain change failed and identity recovery is incomplete; retry recovery before another rename');
    }
    throw failure;
  }
}
