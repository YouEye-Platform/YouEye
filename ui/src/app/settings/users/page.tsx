import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { AdminEmbed } from "@/components/settings/admin-embed";

export default async function UsersSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  const signedUrl = getSignedEmbedUrl("users", session.username, true, { theme: "dark" });
  if (!signedUrl) redirect("/settings");

  return <AdminEmbed signedUrl={signedUrl} title="User Management" minHeight={400} />;
}
