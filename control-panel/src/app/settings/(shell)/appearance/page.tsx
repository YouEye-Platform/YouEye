import { AppearanceClient } from "@/components/settings-shell/appearance-client";
import { PageHeader } from "@/components/settings-shell/page-header";

export default function AppearanceSettingsPage() {
  return (
    <>
      <PageHeader title="Appearance" description="Choose your theme and display mode." />
      <AppearanceClient />
    </>
  );
}
