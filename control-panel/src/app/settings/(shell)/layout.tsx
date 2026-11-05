import { redirect } from "next/navigation";
import { ControlHeader } from "@/components/control-surface/control-header";
import { getSession } from "@/lib/auth/session";
import { SettingsShell } from "@/components/settings-shell/settings-shell";

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/settings/login");
  const hasUserContext = session.authMethod !== "pam" && session.authMethod !== "cli";

  return (
    <div className="min-h-screen bg-background">
      <ControlHeader username={session.username} isAdmin={session.isAdmin} hasUserContext={hasUserContext} />
      <SettingsShell isAdmin={session.isAdmin} username={session.username} hasUserContext={hasUserContext}>
        {children}
      </SettingsShell>
    </div>
  );
}
