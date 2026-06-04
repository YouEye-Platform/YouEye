import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { SettingsShell } from "@/components/settings-shell/settings-shell";

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/settings/login");

  return (
    <div className="min-h-screen bg-background">
      <SettingsShell isAdmin={session.isAdmin} username={session.username}>
        {children}
      </SettingsShell>
    </div>
  );
}
