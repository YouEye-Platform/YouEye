// Shared by the server page and the client: a "use client" module's functions can't be called on the server.
export type NetworkTab = "address" | "dns" | "routes";

/** No tab is "Address & HTTPS"; the old `domain` and `tls` values, and anything unknown, open it too. */
export function networkTabFromParam(tab: string | null | undefined): NetworkTab {
  if (tab === "dns" || tab === "routes") return tab;
  return "address";
}
