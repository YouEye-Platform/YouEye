/** Keep catalog entries independent: one unavailable manifest must not hide its peers. */
export async function loadCatalogEntries<T, R>(
  entries: readonly T[],
  load: (entry: T) => Promise<R>,
  onFailure: (entry: T, error: unknown) => void,
): Promise<R[]> {
  const results = await Promise.allSettled(entries.map(async (entry) => load(entry)));
  const loaded: R[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') loaded.push(result.value);
    else onFailure(entries[index], result.reason);
  });
  return loaded;
}

export interface CatalogWarning {
  sourceId: string;
  itemId?: string;
  message: string;
}
