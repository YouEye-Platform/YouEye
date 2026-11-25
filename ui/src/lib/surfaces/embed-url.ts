/**
 * The address of an app's embedded surface: its `embed_path` on the app's public address (`app_url`, built by the
 * server, `lib/surfaces/app-url.ts`). Null when there is no address, or when the path would leave the app's origin
 * (an absolute URL or `//host`): the caller then shows its standard card. Safe on the client.
 */
export function surfaceEmbedUrl(
  appUrl: string | null | undefined,
  embedPath: string | null | undefined,
  params: Record<string, string> = {},
): string | null {
  if (!appUrl || !embedPath) return null;
  try {
    const origin = new URL(appUrl);
    if (origin.protocol !== "https:") return null;
    const url = new URL(embedPath, origin);
    if (url.origin !== origin.origin) return null;
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  } catch {
    return null;
  }
}
