import {
  AppUpdateJournalStore, updateResourceKey, type AppUpdateJournalLease,
  type AppUpdateRecord, type NewAppUpdate, type UpdateCheckpoint, type UpdateResource,
} from './update-journal';

export interface AppUpdateProvider {
  /** Persist protected recovery plan before any provider effect. */
  initialize(record: AppUpdateRecord): Promise<void>;
  quiesce(record: AppUpdateRecord): Promise<void>;
  checkpoint(record: AppUpdateRecord, resource: UpdateResource): Promise<UpdateCheckpoint>;
  validateCheckpoints(record: AppUpdateRecord): Promise<void>;
  applying?(record: AppUpdateRecord): Promise<void>;
  /** Idempotently restore the complete compatible set, retaining recovery points. */
  restore(record: AppUpdateRecord): Promise<void>;
  verifyRestored(record: AppUpdateRecord): Promise<void>;
  /** On any recovery failure, reestablish and verify writer exclusion. */
  fenceRecovery?(record: AppUpdateRecord): Promise<void>;
  /** Reopen only a durably committed or verified rolled-back operation. */
  reopen(record: AppUpdateRecord): Promise<void>;
  /** Remove only this operation's provider-owned checkpoints/payloads. */
  cleanup(record: AppUpdateRecord): Promise<void>;
}

export class AppUpdateTransaction {
  constructor(readonly lease: AppUpdateJournalLease, private readonly provider: AppUpdateProvider) {}
  record(): AppUpdateRecord { return this.lease.snapshot(); }
  async mutate<T>(id: string, effect: () => Promise<T>): Promise<T> {
    this.lease.intent(id);
    const result = await effect();
    this.lease.assertActive();
    this.lease.complete(id);
    return result;
  }
  async prepare(): Promise<void> {
    await this.mutate('initialize-recovery-plan', () => this.provider.initialize(this.record()));
    this.lease.transition('quiescing');
    await this.mutate('quiesce-writers', () => this.provider.quiesce(this.record()));
    this.lease.transition('checkpointing');
    for (const resource of this.record().resources.filter(r => r.mutable)) {
      const point = await this.mutate(`checkpoint-${updateResourceKey(resource).slice(0, 24)}`,
        () => this.provider.checkpoint(this.record(), resource));
      this.lease.checkpoint(point);
    }
    await this.mutate('validate-recovery-set', () => this.provider.validateCheckpoints(this.record()));
    this.lease.transition('prepared');
    this.lease.transition('applying');
    if (this.provider.applying) {
      await this.mutate('allow-migration-database', () => this.provider.applying!(this.record()));
    }
  }
  verifying(): void { this.lease.transition('verifying'); }
  async commit(metadataDigest: string): Promise<void> {
    this.lease.commit(metadataDigest);
    await this.finish();
  }
  async finish(): Promise<void> {
    const record = this.record();
    if (!record.commit && !record.rollbackVerifiedAt) throw new Error('Unverified operation cannot reopen traffic');
    this.lease.transition('cleanup');
    // Reconcile these idempotent effects if death occurred before acknowledgement.
    for (const [id, effect] of [
      ['reopen-compatible-app', () => this.provider.reopen(this.record())],
      ['cleanup-recovery-set', () => this.provider.cleanup(this.record())],
    ] as const) {
      const step = this.record().steps.find(s => s.id === id);
      if (step?.state === 'completed') continue;
      if (!step) this.lease.intent(id);
      await effect();
      this.lease.complete(id);
    }
    this.lease.finishCleanup();
  }
  async recover(): Promise<void> {
    if (this.record().commit || this.record().rollbackVerifiedAt) {
      await this.finish();
      return;
    }
    try {
      this.lease.transition('recovering');
      // Restore handles ambiguous outcomes rather than replaying non-idempotent apply.
      await this.provider.restore(this.record());
      await this.provider.verifyRestored(this.record());
      for (const step of this.record().steps.filter(s => s.state === 'intent')) this.lease.complete(step.id);
      this.lease.rolledBack();
      await this.finish();
    } catch (error) {
      if (!this.record().rollbackVerifiedAt) {
        let errorCode = 'scoped-restore-unverified';
        try { await this.provider.fenceRecovery?.(this.record()); }
        catch { errorCode = 'recovery-fence-unverified'; }
        this.lease.recoveryRequired(errorCode);
      }
      throw error;
    }
  }
}

export async function runAppUpdateTransaction<T>(
  store: AppUpdateJournalStore, input: NewAppUpdate, provider: AppUpdateProvider,
  apply: (transaction: AppUpdateTransaction) => Promise<{ value: T; metadataDigest: string }>,
  onAdmitted?: (operationId: string) => void,
): Promise<T> {
  return store.withExecutor(input, async lease => {
    const transaction = new AppUpdateTransaction(lease, provider);
    try {
      onAdmitted?.(lease.snapshot().id);
      await transaction.prepare();
      const result = await apply(transaction);
      if (transaction.record().phase !== 'verifying') throw new Error('Update verification phase was not completed');
      await transaction.commit(result.metadataDigest);
      return result.value;
    } catch (error) {
      // Committed data must never be rewound because reopening or cleanup failed.
      if (!transaction.record().commit) await transaction.recover();
      throw error;
    }
  });
}
