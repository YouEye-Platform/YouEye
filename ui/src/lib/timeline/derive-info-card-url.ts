/**
 * Derive Info Card Target URL
 *
 * Given a timeline entry's type and metadata, construct a real target URL that
 * can be matched against app-declared info-card surface triggers. This avoids
 * reconstructing old host/app JSON card endpoints.
 */

interface TimelineEntryMeta {
  entry_type: string;
  app_id: string;
  data: Record<string, unknown>;
  tags: Record<string, unknown>;
}

/**
 * Attempt to derive an info card target URL from entry metadata.
 * Returns null if the entry type is not recognized or the
 * required metadata is missing.
 */
export function deriveInfoCardTargetUrl(entry: TimelineEntryMeta): string | null {
  if (typeof entry.data.url === "string" && entry.data.url) {
    return entry.data.url;
  }

  const entityId = extractEntityId(entry);
  if (!entityId) return null;

  switch (true) {
    // Wiki article read/edit events
    case entry.entry_type.startsWith("wiki-article"):
      return `https://en.wikipedia.org/wiki/${encodeURIComponent(entityId.replace(/\s+/g, "_"))}`;

    default:
      return null;
  }
}

/**
 * Extract the entity ID from entry data or tags.
 * Different entry types store the entity ID in different places.
 */
function extractEntityId(entry: TimelineEntryMeta): string | null {
  // Check common fields
  const { data, tags } = entry;

  // Direct entityId field
  if (typeof data.entityId === "string" && data.entityId) {
    return data.entityId;
  }

  // Article slug from data
  if (typeof data.articleSlug === "string" && data.articleSlug) {
    return data.articleSlug;
  }

  // Search query from data
  if (typeof data.query === "string" && data.query) {
    return data.query;
  }

  // Tag-based extraction
  if (typeof tags.entityId === "string" && tags.entityId) {
    return tags.entityId;
  }

  if (typeof tags.slug === "string" && tags.slug) {
    return tags.slug;
  }

  if (typeof tags.query === "string" && tags.query) {
    return tags.query;
  }

  return null;
}
