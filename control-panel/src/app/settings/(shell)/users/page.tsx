import { redirect } from "next/navigation";
import PeoplePage from "@/app/(dashboard)/people/page";
import { PageHeader } from "@/components/settings-shell/page-header";
import { getSession } from "@/lib/auth/session";

export default async function UsersSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  return (
    <>
      <PageHeader title="Users" description="Manage YouEye users and access." />
      <PeoplePage />
    </>
  );
}
