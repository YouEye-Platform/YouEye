/** Called under TLS serialization after validation and protected snapshots. */
export async function applyUploadedCertificateWithRecovery(actions: {
  persist: () => Promise<void>;
  activate: () => Promise<void>;
  restoreProxy: () => Promise<void>;
  restoreStorage: () => Promise<void>;
}): Promise<{ ok: true } | { ok: false; recovered: boolean }> {
  try {
    await actions.persist();
    await actions.activate();
    return { ok: true };
  } catch {
    let recovered = true;
    // Attempt both recovery effects even when one is unavailable.
    try { await actions.restoreProxy(); } catch { recovered = false; }
    try { await actions.restoreStorage(); } catch { recovered = false; }
    return { ok: false, recovered };
  }
}
