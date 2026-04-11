/**
 * Appearance Settings Page
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AppearanceSettings } from "@/components/settings/appearance-settings";

export default async function AppearancePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <AppearanceSettings userId={session.userId} isAdmin={session.isAdmin} />
  );
}
