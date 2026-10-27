function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => [key, canonical(field)]));
  }
  return value;
}

/** Compare the observed persisted projection with current desired data. The
 * server timestamp is bookkeeping, not a reason to rewrite an unchanged row. */
export function sameConnectionProjection(observed: unknown, desired: unknown): boolean {
  if (!observed || typeof observed !== 'object' || Array.isArray(observed)) return false;
  const { updatedAt: _timestamp, ...data } = observed as Record<string, unknown>;
  return JSON.stringify(canonical(data)) === JSON.stringify(canonical(desired));
}
