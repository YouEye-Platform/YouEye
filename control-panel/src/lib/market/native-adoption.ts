/**
 * The update check's pass over installed native apps that takes a market's new manifest for the package an app runs,
 * metadata only (YE-142, YE-194). The pass lives here with its dependencies passed in; `adoptNativeMarketManifests`
 * in `updater.ts` gives it the real ones.
 *
 * Compare first, lock only on a change (YE-210). Reading the record and the market's manifest and comparing their
 * digests changes nothing, so it runs without any lock. Only an app whose market manifest differs from its record
 * (and was not tried already for that pair) takes the update exclusion, its lifecycle lock and its network lock, and
 * eligibility and the plan are decided again inside them before anything is written. An app that is up to date therefore never waits
 * behind a user's operation, and never announces an operation: the reconcile queue is not re-run and the route
 * guard (YE-198) never sees it held.
 */

export interface NativeAdoptionOutcome {
  moved: boolean;
  reason?: string;
}

export interface NativeAdoptionDeps<Plan, Outcome extends NativeAdoptionOutcome> {
  /** The installed apps, in order. */
  appIds(): Promise<string[]>;
  /** An app update is running: the pass stops and the next check tries again. */
  updateRunning(): boolean;
  /** A native app whose service credentials are ready (read-only). */
  eligible(appId: string): Promise<boolean>;
  /** Read-only: what to adopt, or null when the record already has the market's manifest (or was tried for it). */
  plan(appId: string): Promise<Plan | null>;
  /** The update exclusion and the app's lifecycle and network locks around `work`. */
  locked<T>(appId: string, work: () => Promise<T>): Promise<T>;
  /** Take the planned manifest (inside `locked`). */
  adopt(appId: string, plan: Plan): Promise<Outcome>;
  /** One app's result, for the log. */
  report(appId: string, outcome: Outcome): void;
  /** One app's failure, for the log; the pass goes on with the next app. */
  failed(appId: string, error: unknown): void;
}

export async function adoptChangedNativeManifests<Plan, Outcome extends NativeAdoptionOutcome>(
  deps: NativeAdoptionDeps<Plan, Outcome>,
): Promise<string[]> {
  const adopted: string[] = [];
  for (const appId of await deps.appIds()) {
    // A check never waits behind an app update: it is tried again at the next check.
    if (deps.updateRunning()) return adopted;
    try {
      if (!await deps.eligible(appId)) continue;
      // Up to date (the common case at every check): no lock, no operation, nothing announced.
      if (!await deps.plan(appId)) continue;
      const outcome = await deps.locked(appId, async () => {
        // The record or the market may have changed while waiting for the locks, and so may the app's eligibility (an
        // uninstall that did not complete leaves its credentials pending): both are decided again inside (YE-218).
        if (!await deps.eligible(appId)) return null;
        const current = await deps.plan(appId);
        return current ? deps.adopt(appId, current) : null;
      });
      if (!outcome) continue;
      if (outcome.moved) adopted.push(appId);
      deps.report(appId, outcome);
    } catch (error) {
      deps.failed(appId, error);
    }
  }
  return adopted;
}
