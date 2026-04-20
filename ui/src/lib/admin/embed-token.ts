/**
 * Embed URL Generator — server-side only.
 *
 * One-way bridge: CP embeds now use session-based auth (same SSO session
 * as main CP). UI no longer needs the bridge token for embed URLs.
 *
 * The CP validates the user's session cookie when loading embed pages.
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
  const cpBase = process.env.CP_EMBED_URL || "https://control.devvm.test";

  if (extraParams && Object.keys(extraParams).length > 0) {
    const params = new URLSearchParams(extraParams);
    return `${cpBase}/embed/${section}?${params.toString()}`;
  }

  return `${cpBase}/embed/${section}`;
}
