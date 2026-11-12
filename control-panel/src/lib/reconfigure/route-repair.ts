/** Reject a background route write from metadata captured before URL migration. */
export async function repairRouteForCurrentDomain(
  metadataDomain: string,
  operations: {
    pending: () => Promise<unknown>;
    domain: () => Promise<string | undefined>;
    repair: () => Promise<void>;
  },
): Promise<boolean> {
  if (await operations.pending()) return false;
  if (metadataDomain !== await operations.domain()) return false;
  if (await operations.pending()) return false;
  await operations.repair();
  return true;
}
