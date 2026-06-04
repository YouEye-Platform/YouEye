import { PageHeader } from "@/components/settings-shell/page-header";
import { PinClient } from "@/components/settings-shell/pin-client";

export default function PrivacySettingsPage() {
  return (
    <>
      <PageHeader title="Privacy" description="Manage your encryption PIN." />
      <PinClient />
    </>
  );
}
