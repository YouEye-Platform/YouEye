import { AppsClient } from "@/components/settings-shell/apps-client";
import { PageHeader } from "@/components/settings-shell/page-header";

export default function PermissionsSettingsPage() {
  return (
    <>
      <PageHeader
        title="Permissions"
        description="Review app visibility and app-specific access from the apps settings."
      />
      <AppsClient />
    </>
  );
}
