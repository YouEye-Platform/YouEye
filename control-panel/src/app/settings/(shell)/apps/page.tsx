import { AppsClient } from "@/components/settings-shell/apps-client";
import { PageHeader } from "@/components/settings-shell/page-header";

export default function AppsSettingsPage() {
  return (
    <>
      <PageHeader title="Apps" description="Choose which apps appear in your drawer." />
      <AppsClient />
    </>
  );
}
