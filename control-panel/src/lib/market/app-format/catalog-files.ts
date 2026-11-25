import { parseCatalog } from './parse';
import type { Catalog, CatalogEntry } from '../types';

/**
 * Build a source's catalog from `catalog.yaml` and the ids found in its folders
 * (`apps/<id>/youeye-app.yaml`, `bundles/<id>/bundle.yaml`). Other files are not listed.
 */
export function catalogFromFiles(catalogYaml: string, files: Iterable<string>): Catalog {
  const document = parseCatalog(catalogYaml);
  const apps: CatalogEntry[] = [];
  const bundles: string[] = [];
  for (const file of files) {
    let match = /^apps\/([a-z][a-z0-9-]{0,31})\/youeye-app\.yaml$/.exec(file);
    if (match) { apps.push({ id: match[1], integration: 'basic', path: `apps/${match[1]}` }); continue; }
    match = /^bundles\/([a-z][a-z0-9-]{0,31})\/bundle\.yaml$/.exec(file);
    if (match) bundles.push(match[1]);
  }
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  return {
    apps: apps.sort(byId),
    bundles: bundles.sort(),
    categories: (document.categories ?? []).map((category) => ({ ...category })),
    curation: document.curation ? {
      spotlight: document.curation.spotlight
        ? { title: document.curation.spotlight.title, apps: [...document.curation.spotlight.apps] } : undefined,
      collections: (document.curation.collections ?? []).map((collection) => ({ ...collection, apps: [...collection.apps] })),
    } : undefined,
  };
}
