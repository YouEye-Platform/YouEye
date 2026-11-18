/**
 * The parameter of an "Add to YouEye" link (`/market/add?market=<address>` or `?app=<manifest URL>`), checked before
 * anything is fetched. A link comes from anywhere on the web; it is only ever shown and fetched, never acted on.
 */
import { MAX_SIGN_IN_RETURN_PATH } from '@/components/market/sign-in-location';
import { checkedMarketAddress } from '@/lib/market/source';
import { resolveAppManifestUrl, validateAppUrl } from '@/lib/market/url-app';

/** The page an "Add to YouEye" link opens. */
export const ADD_LINK_PAGE = '/market/add';

/**
 * The page's address as a signed-out owner's sign-in carries it back (path and encoded query). A link is accepted only
 * when this stays within the sign-in return path's limit (`MAX_SIGN_IN_RETURN_PATH`, `safeOAuthReturn` in
 * shared/oauth-transaction.ts), so a link that works when signed in is never dropped by a sign-in.
 */
export function addLinkReturnPath(kind: 'market' | 'app', value: string): string {
  return `${ADD_LINK_PAGE}?${kind}=${encodeURIComponent(value)}`;
}

export type AddLinkParameter =
  | { kind: 'market'; address: string }
  | { kind: 'app'; url: string };

export function addLinkParameter(params: URLSearchParams): AddLinkParameter | { error: string } {
  const markets = params.getAll('market');
  const apps = params.getAll('app');
  if (markets.length + apps.length !== 1) return { error: 'The link must name exactly one market or one app.' };
  const kind = markets.length ? 'market' : 'app';
  const value = markets[0] ?? apps[0];
  if (!value) return { error: 'The link has no address.' };
  if (addLinkReturnPath(kind, value).length > MAX_SIGN_IN_RETURN_PATH) {
    return { error: `The link is too long: it must stay within ${MAX_SIGN_IN_RETURN_PATH.toLocaleString('en')} characters once encoded, or it would be lost when you sign in.` };
  }
  // Control characters, spaces and backslashes have no place in an address; browsers would repair some of them.
  if (/[\u0000- \u007f-\u009f\\]/.test(value)) return { error: 'The address contains characters that are not allowed.' };
  let url: URL;
  try { url = new URL(value); } catch { return { error: 'The address is not a web address.' }; }
  if (url.protocol !== 'https:') return { error: 'The address must start with https://.' };
  if (url.username || url.password) return { error: 'The address must not contain a user name or password.' };
  if (kind === 'market') {
    try { return { kind, address: checkedMarketAddress(value) }; }
    catch (error) { return { error: error instanceof Error ? error.message : 'This is not a market address.' }; }
  }
  // The same manifest URL the add call (`POST /api/market/validate-url`) reads.
  const manifestUrl = resolveAppManifestUrl(value);
  const problem = validateAppUrl(manifestUrl);
  return problem ? { error: problem } : { kind, url: manifestUrl };
}
