import { isIP } from 'node:net';
import type { NextRequest } from 'next/server';

export function privateNamesAddress(value: string): boolean {
  if (isIP(value)===6) return /^(?:fc|fd)[0-9a-f]{2}:/i.test(value);
  if (isIP(value)!==4) return false;
  const [first,second]=value.split('.').map(Number);
  return first===10 || (first===172 && second>=16 && second<=31) || (first===192 && second===168) || (first===100 && second>=64 && second<=127);
}

/** Browser Origin is checked against the actual request Host, never against a
 * caller-supplied parent field or guessed platform domain. Caddy preserves Host. */
export function verifiedSetupParentOrigin(request: NextRequest): string {
  const value=request.headers.get('origin');
  if (!value) throw new Error('verified_setup_origin_required');
  const origin=new URL(value);
  const host=request.headers.get('host') || request.nextUrl.host;
  if (origin.origin!==value || origin.host.toLowerCase()!==host.toLowerCase() || origin.username || origin.password || origin.hostname.includes('*') || origin.pathname!=='/' || origin.search || origin.hash || !['http:','https:'].includes(origin.protocol)) throw new Error('verified_setup_origin_invalid');
  if (origin.protocol==='http:' && origin.hostname!=='localhost' && !privateNamesAddress(origin.hostname.replace(/^\[|\]$/g,''))) throw new Error('verified_setup_origin_invalid');
  return origin.origin;
}
