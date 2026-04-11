/**
 * Derive Info Card URL
 *
 * Given a timeline entry's type and metadata, construct the likely
 * info card URL. Used for retroactive enrichment of entries that
 * were created before info cards existed.
 */

interface TimelineEntryMeta {
  entry_type: string;
  app_id: string;
  data: Record<string, unknown>;
  tags: Record<string, unknown>;
}

/**
 * Attempt to derive an info card URL from entry metadata.
 * Returns null if the entry type is not recognized or the
 * required metadata is missing.
 */
export function deriveInfoCardUrl(
  entry: TimelineEntryMeta,
  domain: string
): string | null {
  const entityId = extractEntityId(entry);
  if (!entityId) return null;

  switch (true) {
    // Wiki article read/edit events
    case entry.entry_type.startsWith("wiki-article"):
      return `https://wiki.${domain}/api/cards/article-summary?url=${encodeURIComponent(`/wiki/${entityId}`)}`;

    // Search query events
    case entry.entry_type === "search-query":
      return `https://search.${domain}/api/inter-app/provide?type=search-snippet&query=${encodeURIComponent(entityId)}`;

    // Notes app (future)
    case entry.entry_type.startsWith("notes-note"):
      return `https://notes.${domain}/api/cards/note-summary?id=${encodeURIComponent(entityId)}`;

    // Photos app (future)
    case entry.entry_type.startsWith("photos-photo"):
      return `https://photos.${domain}/api/cards/photo-preview?id=${encodeURIComponent(entityId)}`;

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
