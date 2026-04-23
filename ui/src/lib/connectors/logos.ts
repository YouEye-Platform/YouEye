/**
 * Connector Logo URLs — fetched from Gitea raw files.
 *
 * Connectors stored as folders in YE-AppMarket get their logos from
 * the folder (e.g., connectors/spotify-music/logo.svg). Connectors
 * stored as single YAML files get a generated fallback.
 */

const GITEA_BASE = "https://git.byka.wtf";
const REPO_OWNER = "potemsla";
const REPO_NAME = "YE-AppMarket";

function getEffectiveBranch(): string {
  return process.env.APPMARKET_BRANCH || "main";
}

/** Connectors that are stored as folders (have logo.svg) */
const FOLDER_CONNECTORS = new Set([
  "navidrome-music",
  "spotify-music",
  "soundcloud-music",
  "openstreetmap-tiles",
  "maptiler-tiles",
  "nominatim-geocoding",
  "immich-photos",
  "google-places",
  "libretranslate-translation",
  "tmdb-media",
]);

/**
 * Build the Gitea raw URL for a connector's logo.
 * Returns null for connectors stored as single YAML files (no logo).
 */
export function connectorLogoUrl(connectorId: string): string | null {
  if (!FOLDER_CONNECTORS.has(connectorId)) return null;
  const branch = getEffectiveBranch();
  return `${GITEA_BASE}/${REPO_OWNER}/${REPO_NAME}/raw/branch/${branch}/connectors/${connectorId}/logo.svg`;
}
