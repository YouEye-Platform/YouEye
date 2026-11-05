/** Retry only admission contention; a started capture is never repeated. */
export async function runWithBackupAdmission<T>(
  work: () => Promise<T>, admit: (work: () => Promise<T>) => Promise<T>,
  options: { attempts?: number; pause?: () => Promise<void> } = {},
): Promise<T> {
  const attempts = options.attempts ?? 40;
  const pause = options.pause ?? (() => new Promise<void>(resolve => setTimeout(resolve, 250)));
  for (let attempt = 0; ; attempt++) {
    let entered = false;
    try {
      return await admit(async () => { entered = true; return work(); });
    } catch (error) {
      if (entered || !(error instanceof Error) || error.message !== 'App update executor lock is busy'
        || attempt + 1 >= attempts) throw error;
      await pause();
    }
  }
}
