import { PageHeader } from "@/components/settings-shell/page-header";

export default async function AccountsSettingsPage() {
  return (
    <>
      <PageHeader title="Accounts" description="Manage connected OAuth accounts." />
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        No connected account providers are configured.
      </div>
    </>
  );
}
