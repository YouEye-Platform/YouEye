import opentype, { type Font } from "../vendor/opentype/index.js";
const cache = new Map<string, Font>();
const pending = new Map<string, Promise<Font>>();
/** Server adapters load the same pinned local bytes; no network or system fonts. */
export function registerFont(id: string, bytes: ArrayBuffer): void {
  cache.set(id, opentype.parse(bytes));
}
export function getFont(id: string) {
  return cache.get(id);
}
export function ensureFont(id: string): Promise<Font> {
  if (cache.has(id)) return Promise.resolve(cache.get(id)!);
  if (pending.has(id)) return pending.get(id)!;
  const task = fetch(`/mytitle/fonts/${id}.ttf`)
    .then((r) => {
      if (!r.ok) throw new Error("Could not load lettering. Please retry.");
      return r.arrayBuffer();
    })
    .then((b) => {
      const f = opentype.parse(b);
      cache.set(id, f);
      return f;
    })
    .catch((e) => {
      pending.delete(id);
      throw e;
    });
  pending.set(id, task);
  return task;
}
