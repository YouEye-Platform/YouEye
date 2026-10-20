import type { NextRequest } from 'next/server';

// Older NextURL versions replaced loopback IPs anywhere in the URL string, including an
// encoded redirect_uri query value. Preserve the original query at the
// middleware boundary so OIDC redirect matching remains byte-for-byte exact.
export const ORIGINAL_IDENTITY_QUERY_HEADER = 'x-youeye-original-identity-query';

export function originalIdentityQuery(request: NextRequest): string {
  const rawUrl = Reflect.get(Request.prototype, 'url', request) as string;
  return new URL(rawUrl).search.slice(1);
}

export function identitySearchParams(request: NextRequest): URLSearchParams {
  // Middleware overwrites this header on every authorization request, so a
  // value supplied by a client cannot influence redirect validation.
  const query = request.headers.get(ORIGINAL_IDENTITY_QUERY_HEADER);
  if (query === null) throw new Error('Authorization query was not preserved by middleware');
  return new URLSearchParams(query);
}
