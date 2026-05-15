/**
 * Embed URL Generator — server-side only.
 *
 * One-way bridge: Control Panel embeds now use session-based auth (same SSO session
 * as main Control Panel). UI no longer needs the bridge token for embed URLs.
 *
 * The Control Panel validates the user's session cookie when loading embed pages.
 * If not logged in, CP shows a sign-in prompt within the iframe.
 */

/**
 * Get embed URL for a CP section.
 *
 * @param section - The embed section (e.g., "containers", "backup")
 * @param _username - Unused, kept for API compatibility
 * @param _isAdmin - Unused, kept for API compatibility
 * @param extraParams - Optional query params (e.g., theme, accent)
 */
export function getSignedEmbedUrl(
  section: string,
  _username: string,
  _isAdmin: boolean,
  extraParams?: Record<string, string>
): string {
  // Derive CP base from UI_EXTERNAL_URL by prepending "control." to the domain.
  // e.g. "https://skibidi.io" → "https://control.skibidi.io"
  const cpBase = process.env.UI_EXTERNAL_URL?.replace('://', '://control.')
    || 'https://localhost';

  if (extraParams && Object.keys(extraParams).length > 0) {
    const params = new URLSearchParams(extraParams);
    return `${cpBase}/embed/${section}?${params.toString()}`;
  }

  return `${cpBase}/embed/${section}`;
}
