import { redirect } from "next/navigation";
import { UsersEmbedClient } from "@/app/embed/users/client";
import { PageHeader } from "@/components/settings-shell/page-header";
import { getSession } from "@/lib/auth/session";

export default async function UsersSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  return (
    <>
      <PageHeader title="Users" description="Manage YouEye users and access." />
      <UsersEmbedClient />
    </>
  );
}
