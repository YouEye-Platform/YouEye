import { redirect } from "next/navigation";
import { ControlHeader } from "@/components/control-surface/control-header";
import { getSession } from "@/lib/auth/session";

export async function MarketShell({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/settings/login");
  if (!session.isAdmin) redirect("/settings");
  const hasUserContext = session.authMethod !== "pam" && session.authMethod !== "cli";

  return (
    <div className="min-h-screen bg-background">
      <ControlHeader username={session.username} isAdmin={session.isAdmin} hasUserContext={hasUserContext} />
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
