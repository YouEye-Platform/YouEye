import { redirect } from "next/navigation";
import { AboutClient } from "@/components/settings-shell/about-client";
import { getSession } from "@/lib/auth/session";

export default async function AboutSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");
  return <AboutClient />;
}
