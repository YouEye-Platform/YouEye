/** Bounded component protocol; neither claimed Content-Length nor an upstream
 * response body may allocate unbounded memory in the native update path. */
export async function readCoreComponentJSON(body: ReadableStream<Uint8Array> | null, limit: number): Promise<unknown> {
  if (!body || !Number.isSafeInteger(limit) || limit < 1 || limit > 16384) throw new Error('Bounded core component body required');
  const reader = body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('Core component body exceeds bound');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export type CoreUIReceipt = {
  schema: 'youeye.core-component.v1'; role: 'ui'; requestId: string; manifestSHA256: string; artifactSHA256: string;
  managed: true; state: 'pending' | 'started' | 'completed' | 'unknown';
};
const digest = /^[a-f0-9]{64}$/, request = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export function parseCoreUIReceipt(value: unknown, artifact: string): CoreUIReceipt {
  const r = value as Partial<CoreUIReceipt> | null;
  if (!r || r.schema !== 'youeye.core-component.v1' || r.role !== 'ui' || r.managed !== true
    || !request.test(r.requestId ?? '') || !digest.test(r.manifestSHA256 ?? '') || !digest.test(artifact)
    || r.artifactSHA256 !== artifact || !['pending', 'started', 'completed', 'unknown'].includes(r.state ?? '')) {
    throw new Error('UI core receipt differs from selected member');
  }
  return { schema: r.schema, role: r.role, requestId: r.requestId!, manifestSHA256: r.manifestSHA256!, artifactSHA256: artifact, managed: true, state: r.state! };
}

/** CP is the UI worker: observe first and only request an exact pending attempt.
 * The UI's durable once-only receipt handles concurrent delivery; started and
 * unknown attempts remain observations and never receive another migration POST. */
export async function reconcileCoreUI(
  artifact: string,
  transport: (method: 'GET' | 'POST', body?: object) => Promise<unknown>,
  requested?: unknown,
): Promise<CoreUIReceipt> {
  const current = parseCoreUIReceipt(await transport('GET'), artifact);
  if (requested === undefined) return current;
  const input = requested as Partial<CoreUIReceipt> | null;
  if (!input || input.requestId !== current.requestId || input.manifestSHA256 !== current.manifestSHA256 || input.artifactSHA256 !== artifact) {
    throw new Error('UI core request differs from installed identity');
  }
  if (current.state !== 'pending') return current;
  const result = parseCoreUIReceipt(await transport('POST', {
    requestId: current.requestId, manifestSHA256: current.manifestSHA256, artifactSHA256: artifact,
  }), artifact);
  if (result.requestId !== current.requestId || result.manifestSHA256 !== current.manifestSHA256) throw new Error('UI core identity changed during schema request');
  return result;
}
