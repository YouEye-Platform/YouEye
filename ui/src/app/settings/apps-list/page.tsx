import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { AdminEmbed } from "@/components/settings/admin-embed";

export default async function AppsListPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  const signedUrl = getSignedEmbedUrl("apps", session.username, true, { theme: "dark" });
  if (!signedUrl) redirect("/settings");

  return <AdminEmbed signedUrl={signedUrl} title="Apps &amp; Updates" minHeight={500} />;
}
