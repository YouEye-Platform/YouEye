import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { AppsListClient } from "./client";

export default async function AppsSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const updatesEmbedUrl = session.isAdmin
    ? getSignedEmbedUrl("apps", "", true, { section: "updates" })
    : null;

  const systemEmbedUrl = session.isAdmin
    ? getSignedEmbedUrl("apps", "", true, { section: "system" })
    : null;

  return (
    <AppsListClient
      isAdmin={session.isAdmin}
      updatesEmbedUrl={updatesEmbedUrl}
      systemEmbedUrl={systemEmbedUrl}
    />
  );
}
