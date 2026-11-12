import path from 'node:path';
import { appUpdateJournalStore } from '../market/update-admission';
import { withAppUpdateExecutorLock } from '../market/update-executor-lock';
import { withSetupRequestWork } from '../setup/readiness';

/** Serialize certificate changes and retain native admission across awaits. */
export function withTlsMutation<T>(authMethod: string | undefined, work: () => Promise<T>): Promise<T> {
  return withSetupRequestWork(authMethod, () => withAppUpdateExecutorLock(
    path.join(appUpdateJournalStore().directory, 'tls-operation.flock'), work));
}
