import { redirect } from "next/navigation";
import { UsersClient } from "@/components/settings-shell/users-client";
import { getSession } from "@/lib/auth/session";

export default async function UsersSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  return <UsersClient />;
}
