import { redirect } from "next/navigation";
import { Archive, DatabaseBackup, RotateCcw } from "lucide-react";
import { PageHeader } from "@/components/settings-shell/page-header";
import { getSession } from "@/lib/auth/session";

export default async function BackupSettingsPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  return (
    <>
      <PageHeader title="Backup" description="Create and restore platform backups." />
      <div className="grid gap-4 md:grid-cols-3">
        <section className="rounded-lg border bg-card p-5">
          <Archive className="mb-3 h-5 w-5 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Core backup engine</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Control Panel contains the core and per-app backup services. A first-class scheduler UI is still being mapped into this settings surface.
          </p>
        </section>
        <section className="rounded-lg border bg-card p-5">
          <DatabaseBackup className="mb-3 h-5 w-5 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Live volume backups</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Backup execution uses Spine-managed live volume operations so infrastructure data is archived outside the app directory.
          </p>
        </section>
        <section className="rounded-lg border bg-card p-5">
          <RotateCcw className="mb-3 h-5 w-5 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Restore path</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Full restore remains available during setup restore. In-session restore controls need a dedicated safety flow before exposing them here.
          </p>
        </section>
      </div>
    </>
  );
}
