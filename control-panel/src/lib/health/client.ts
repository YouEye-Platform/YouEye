/** Protected service restart; never weaken the route's CSRF requirement. */
export async function restartServiceRequest(slug: string, request: typeof fetch = fetch): Promise<void> {
  const csrfResponse = await request('/settings/api/auth/csrf');
  const csrf = await csrfResponse.json().catch(() => ({}));
  if (!csrfResponse.ok || typeof csrf.csrfToken !== 'string' || !csrf.csrfToken) {
    throw new Error('Could not prepare a protected restart request');
  }
  const response = await request(`/api/health/services/${encodeURIComponent(slug)}/restart`, {
    method: 'POST', headers: { 'X-CSRF-Token': csrf.csrfToken },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success !== true) throw new Error(body.error || 'Restart failed');
}
