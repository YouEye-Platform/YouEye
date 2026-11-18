/**
 * The dashboard icon of an installed app, inlined as a data URI at install time.
 *
 * Icons come only from the market the app is installed from: a picture (`h/files/<sha256>.<ext>`) that the market's
 * accepted index or the app's stored bundle names, read from the box's copy of the market (fetched from the market's
 * own address on first use and checked against the hash in its path). A manifest, catalog entry or install request
 * cannot make the Control Panel request any other address. Anything else falls back to the Lucide icon name.
 */

import { fileHashOf } from './market-format';

const LUCIDE_NAME = /^[a-z0-9-]{1,60}$/;
const DATA_URI = /^data:image\/(png|svg\+xml|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_ICON_BYTES = 512 * 1024;
const MARKET_IMAGE_PREFIX = '/api/market/image?';

export interface AppIconInput {
  appId: string;
  /** `metadata.iconUrl` as resolved by the catalog: `/api/market/image?source=<id>&file=<h/files/…>`. */
  iconUrl?: string;
  /** Lucide fallback name from the listing. */
  lucide?: string;
  /** Owner's install-time choice: a Lucide name or an image data URI. */
  customIcon?: string;
  /** The Market source the app is installed from: the icon must be a picture of that source's market. */
  sourceId?: string;
}

/** The market picture an icon reference names, or null when the reference is anything else. */
export function marketIconPicture(input: Pick<AppIconInput, 'iconUrl' | 'sourceId'>): { sourceId: string; file: string; contentType: string } | null {
  const { iconUrl, sourceId } = input;
  if (!iconUrl?.startsWith(MARKET_IMAGE_PREFIX) || !sourceId || sourceId.startsWith('direct:')) return null;
  const query = new URLSearchParams(iconUrl.slice(MARKET_IMAGE_PREFIX.length));
  const file = query.get('file') ?? '';
  const picture = fileHashOf(file);
  if (!picture || query.get('source') !== sourceId) return null;
  return { sourceId, file, contentType: picture.contentType };
}

export async function resolveAppIcon(
  input: AppIconInput,
  readMarketPicture: (sourceId: string, file: string) => Promise<Buffer | null>,
): Promise<string | null> {
  const custom = input.customIcon?.trim();
  if (custom) {
    if (LUCIDE_NAME.test(custom)) return custom;
    if (custom.length <= MAX_ICON_BYTES * 2 && DATA_URI.test(custom)) return custom;
  }
  const picture = marketIconPicture(input);
  if (picture) {
    try {
      const bytes = await readMarketPicture(picture.sourceId, picture.file);
      if (bytes && bytes.length > 0 && bytes.length <= MAX_ICON_BYTES) {
        return `data:${picture.contentType};base64,${bytes.toString('base64')}`;
      }
    } catch {
      console.warn(`[market] Icon picture of ${input.appId} is unavailable in its market`);
    }
  }
  return input.lucide && LUCIDE_NAME.test(input.lucide) ? input.lucide : null;
}
