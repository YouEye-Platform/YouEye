export interface ContainerRecoveryOperations {
  state(name: string): Promise<string>;
  start(name: string): Promise<void>;
  waitForRunning(name: string): Promise<void>;
}

/**
 * Restore the availability invariant after rollback: every container that was
 * running when the update began must be running before maintenance is released.
 * Returns actionable failures so callers can preserve the primary update error
 * while still reporting incomplete recovery honestly.
 */
export async function recoverOriginallyRunningContainers(
  originalStates: ReadonlyMap<string, string>,
  operations: ContainerRecoveryOperations,
): Promise<string[]> {
  const failures: string[] = [];

  for (const [name, originalState] of originalStates) {
    if (originalState !== 'Running') continue;

    try {
      if (await operations.state(name) !== 'Running') {
        await operations.start(name);
      }
      await operations.waitForRunning(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${message}`);
    }
  }

  return failures;
}
