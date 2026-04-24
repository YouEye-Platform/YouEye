import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AppsListClient } from "./client";

export default async function AppsSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return <AppsListClient isAdmin={session.isAdmin} />;
}
