import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { AdminEmbed } from "@/components/settings/admin-embed";

export default async function ContainersSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  const signedUrl = getSignedEmbedUrl("containers", session.username, true, { theme: "dark" });
  if (!signedUrl) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        Bridge token not configured. Cannot load admin settings.
      </div>
    );
  }

  return <AdminEmbed signedUrl={signedUrl} title="Container Management" />;
}
