import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { AppsListClient } from "./client";

export default async function AppsSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const appsEmbedUrl = session.isAdmin
    ? getSignedEmbedUrl("apps", "", true)
    : null;

  return (
    <AppsListClient isAdmin={session.isAdmin} appsEmbedUrl={appsEmbedUrl} />
  );
}
