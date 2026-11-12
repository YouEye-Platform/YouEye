/**
 * The dashboard icon of an installed app, inlined as a data URI at install time.
 *
 * Icons come only from the app's own files in the accepted official catalog (the
 * `listing.icon_file` next to its `youeye-app.yaml`). Nothing is ever fetched from a URL:
 * a manifest, catalog entry or install request cannot make the Control Panel request an
 * arbitrary (internal or external) address. Anything else falls back to the Lucide icon name.
 */

import path from 'path';

const LUCIDE_NAME = /^[a-z0-9-]{1,60}$/;
const DATA_URI = /^data:image\/(png|svg\+xml|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_ICON_BYTES = 512 * 1024;
const MEDIA: Record<string, string> = {
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
};
const CATALOG_IMAGE_PREFIX = '/api/market/image?catalog=';

export interface AppIconInput {
  appId: string;
  /** `metadata.iconUrl` as resolved by the catalog (`/api/market/image?catalog=<path>` for official files). */
  iconUrl?: string;
  /** Lucide fallback name from the listing. */
  lucide?: string;
  /** Owner's install-time choice: a Lucide name or an image data URI. */
  customIcon?: string;
  /** `apps/<id>/youeye-app.yaml`: the icon must be a file in the same app folder. */
  manifestPath?: string;
}

/** The catalog file path of an official catalog icon, or null when the reference is anything else. */
export function catalogIconPath(input: Pick<AppIconInput, 'iconUrl' | 'manifestPath'>): string | null {
  const { iconUrl, manifestPath } = input;
  if (!iconUrl?.startsWith(CATALOG_IMAGE_PREFIX) || !manifestPath) return null;
  let file: string;
  try {
    file = decodeURIComponent(iconUrl.slice(CATALOG_IMAGE_PREFIX.length));
  } catch {
    return null;
  }
  const folder = path.posix.dirname(manifestPath);
  if (!/^apps\/[a-z0-9][a-z0-9-]{0,63}$/.test(folder)) return null;
  const normalized = path.posix.normalize(file);
  if (normalized !== file || !normalized.startsWith(`${folder}/`) || normalized.includes('..')
    || !/^[A-Za-z0-9._/-]+$/.test(normalized) || !MEDIA[normalized.split('.').pop()!.toLowerCase()]) {
    return null;
  }
  return normalized;
}

export async function resolveAppIcon(
  input: AppIconInput,
  readCatalogFile: (filePath: string) => Promise<Buffer>,
): Promise<string | null> {
  const custom = input.customIcon?.trim();
  if (custom) {
    if (LUCIDE_NAME.test(custom)) return custom;
    if (custom.length <= MAX_ICON_BYTES * 2 && DATA_URI.test(custom)) return custom;
  }
  const file = catalogIconPath(input);
  if (file) {
    try {
      const bytes = await readCatalogFile(file);
      if (bytes.length > 0 && bytes.length <= MAX_ICON_BYTES) {
        return `data:${MEDIA[file.split('.').pop()!.toLowerCase()]};base64,${bytes.toString('base64')}`;
      }
    } catch {
      console.warn(`[market] Icon file of ${input.appId} is unavailable in the catalog`);
    }
  }
  return input.lucide && LUCIDE_NAME.test(input.lucide) ? input.lucide : null;
}
