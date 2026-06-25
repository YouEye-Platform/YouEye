import { isSSOConfigured } from './authentik';

export type AuthMode = 'pam' | 'sso';

/** Check if the Host header looks like direct local/IP access. */
export function isIPAccessHost(host: string): boolean {
  const hostname = host.split(':')[0];
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

export function getAuthModeForHost(host: string): AuthMode {
  return isIPAccessHost(host) || !isSSOConfigured() ? 'pam' : 'sso';
}
