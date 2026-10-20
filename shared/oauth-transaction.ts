/** One short-lived cookie per client and login attempt avoids parallel iframe
 * logins overwriting each other's CSRF state or return destination. */
export type OAuthClient = 'cp' | 'ui';
const statePattern = /^[a-f0-9]{64}$/;

export function oauthTransactionName(client: OAuthClient, state: string | null): string | null {
  return state && statePattern.test(state) ? `ye-${client}-oauth-${state}` : null;
}

export function safeOAuthReturn(value: string | null | undefined, fallback = '/'): string {
  if (!value || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20\x7f]/.test(value)) return fallback;
  try {
    const decoded = decodeURIComponent(value.split(/[?#]/, 1)[0]);
    if (decoded.startsWith('//') || /[\\\x00-\x20\x7f]/.test(decoded)) return fallback;
    const parsed = new URL(value, 'https://oauth.invalid');
    return parsed.origin === 'https://oauth.invalid' ? value : fallback;
  } catch { return fallback; }
}

export function oauthTransactionValue(state: string, returnTo: string): string {
  if (!statePattern.test(state)) throw new Error('Invalid OAuth state');
  return JSON.stringify({ state, returnTo: safeOAuthReturn(returnTo) });
}

export function readOAuthTransaction(value: string | undefined, state: string | null): string | null {
  if (!state || !statePattern.test(state) || !value || value.length > 4096) return null;
  try {
    const parsed = JSON.parse(value) as { state?: unknown; returnTo?: unknown };
    if (parsed.state !== state || typeof parsed.returnTo !== 'string') return null;
    return safeOAuthReturn(parsed.returnTo);
  } catch { return null; }
}

export function excessOAuthTransactions(client: OAuthClient, names: string[]): string[] {
  return names.filter(name => name.startsWith(`ye-${client}-oauth-`) && statePattern.test(name.slice(`ye-${client}-oauth-`.length))).slice(7);
}
