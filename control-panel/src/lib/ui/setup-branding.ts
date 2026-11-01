import "server-only";
import { readFile } from "node:fs/promises";
import { getContainerIP } from "@/lib/incus/container-ip";
import { designSchema } from "@youeye/branding";

/** Called only by the owner-bound, CSRF-protected retained setup operation. */
export async function syncSetupBranding(siteName: string, style: Record<string, unknown>, expectedRevision: string | null) {
  const design = designSchema.parse(style.mytitle);
  if (design.name !== siteName) throw new Error("The title and server name must agree.");
  const address = await getContainerIP("youeye-ui");
  const token = (await readFile("/etc/youeye/ui-bridge-token", "utf8")).trim();
  if (!address || !token) throw new Error("The server appearance service is not ready. Retry this setup step.");
  const result = await fetch(`http://${address}:3000/api/ui-bridge/branding`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-UI-Bridge-Token": token },
    body: JSON.stringify({ site_name: siteName, site_name_style: { ...style, mytitle: design }, expected_revision: expectedRevision }),
    signal: AbortSignal.timeout(30_000), cache: "no-store",
  });
  if (!result.ok) throw new Error("The title and sticker could not be saved. Retry this setup step.");
  const saved = await result.json();
  if (!/^[a-f0-9]{64}$/.test(saved.site_name_style?.mytitleRevision ?? "")) {
    throw new Error("The dashboard does not support this title and sticker yet. Update the matching components before continuing.");
  }
}
