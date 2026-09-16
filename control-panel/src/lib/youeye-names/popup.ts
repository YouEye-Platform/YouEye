'use client';

export type NamesEnrollmentPurpose = 'install_register' | 'lease_claim';

type Challenge = {
  purpose: NamesEnrollmentPurpose;
  serviceOrigin: string;
  enrollmentUrl: string;
  context: string;
  cdata: string;
  publicKey: string;
  installFingerprint: string;
  expiresAt: string;
  name?: string;
};

type PopupResult = {
  protocol: 'youeye-names.enroll-popup';
  v: 1;
  type: 'result';
  sessionId: string;
  proof: string;
  purpose: NamesEnrollmentPurpose;
  expiresAt: string;
  binding: { installFingerprint: string; name?: string };
};

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/csrf', { cache: 'no-store' });
  const body = await response.json().catch(() => ({})) as { csrfToken?: unknown };
  if (!response.ok || typeof body.csrfToken !== 'string') throw new Error('Setup session expired. Refresh setup and sign in again.');
  return body.csrfToken;
}

async function createChallenge(purpose: NamesEnrollmentPurpose, name?: string): Promise<Challenge> {
  const token = await csrfToken();
  const response = await fetch('/api/tls/youeye-names/enrollment', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token },
    body: JSON.stringify({ action: 'challenge', purpose, ...(name ? { name } : {}) }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({})) as { challenge?: Challenge; error?: string };
  if (!response.ok || !body.challenge) throw new Error(body.error || 'Could not start YouEye Names verification.');
  return body.challenge;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function parseResult(value: unknown, challenge: Challenge, sessionId: string): PopupResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (!exactKeys(result, ['protocol', 'v', 'type', 'sessionId', 'proof', 'purpose', 'expiresAt', 'binding'])) return null;
  if (
    result.protocol !== 'youeye-names.enroll-popup' || result.v !== 1 || result.type !== 'result' ||
    result.sessionId !== sessionId || result.purpose !== challenge.purpose ||
    typeof result.proof !== 'string' || result.proof.length < 20 || result.proof.length > 512 ||
    typeof result.expiresAt !== 'string' || Date.parse(result.expiresAt) <= Date.now()
  ) return null;
  if (!result.binding || typeof result.binding !== 'object' || Array.isArray(result.binding)) return null;
  const binding = result.binding as Record<string, unknown>;
  const expectedBindingKeys = challenge.purpose === 'lease_claim' ? ['installFingerprint', 'name'] : ['installFingerprint'];
  if (!exactKeys(binding, expectedBindingKeys) || binding.installFingerprint !== challenge.installFingerprint) return null;
  if (challenge.purpose === 'lease_claim' && binding.name !== challenge.name) return null;
  return result as unknown as PopupResult;
}

/**
 * Run the exact-origin Names popup. The proof exists only in memory and is
 * acknowledged only after the caller has accepted it locally.
 */
export async function runNamesEnrollment(
  purpose: NamesEnrollmentPurpose,
  input: { name?: string; accept: (proof: string) => Promise<void> | void },
): Promise<void> {
  const sessionId = crypto.randomUUID();
  const popup = window.open('about:blank', `youeye-names-${sessionId}`, 'popup,width=520,height=720,resizable=yes,scrollbars=yes');
  if (!popup) throw new Error('Verification was blocked. Allow popups for this YouEye address and try again.');

  let challenge: Challenge;
  try {
    challenge = await createChallenge(purpose, input.name);
  } catch (error) {
    popup.close();
    throw error;
  }
  const serviceOrigin = new URL(challenge.serviceOrigin).origin;
  if (serviceOrigin !== challenge.serviceOrigin || new URL(challenge.enrollmentUrl).origin !== serviceOrigin) {
    popup.close();
    throw new Error('YouEye Names returned an invalid verification address.');
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timeout);
      if (error) {
        popup.close();
        reject(error);
      } else {
        resolve();
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== popup || event.origin !== serviceOrigin || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return;
      const message = event.data as Record<string, unknown>;
      if (
        exactKeys(message, ['protocol', 'v', 'type', 'sessionId']) &&
        message.protocol === 'youeye-names.enroll-popup' && message.v === 1 &&
        message.type === 'ready' && message.sessionId === sessionId
      ) {
        popup.postMessage({
          protocol: 'youeye-names.enroll-popup',
          v: 1,
          type: 'init',
          sessionId,
          context: challenge.context,
          cdata: challenge.cdata,
          publicKey: challenge.publicKey,
        }, serviceOrigin);
        return;
      }
      const result = parseResult(message, challenge, sessionId);
      if (!result) return;
      void Promise.resolve(input.accept(result.proof)).then(() => {
        popup.postMessage({
          protocol: 'youeye-names.enroll-popup', v: 1, type: 'ack', sessionId,
        }, serviceOrigin);
        finish();
      }).catch((error) => finish(error instanceof Error ? error : new Error('YouEye could not accept verification.')));
    };
    window.addEventListener('message', onMessage);
    const timeout = window.setTimeout(() => finish(new Error('Verification timed out. Close the popup and try again.')), 150_000);
    const url = new URL(challenge.enrollmentUrl);
    url.hash = new URLSearchParams({
      handoff: 'v1',
      session: sessionId,
      opener_origin: window.location.origin,
    }).toString();
    popup.location.replace(url.toString());
  });
}

export async function acceptRegistrationProof(proof: string): Promise<void> {
  const token = await csrfToken();
  const response = await fetch('/api/tls/youeye-names/enrollment', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token },
    body: JSON.stringify({ action: 'register', humanVerificationProof: proof }),
    signal: AbortSignal.timeout(45_000),
  });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error || 'YouEye Names did not accept verification.');
}
