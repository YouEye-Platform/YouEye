import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { ConnectorAppList } from "@/components/settings/connector-app-list";
import { PermissionManager } from "@/components/settings/permission-manager";
import { getTranslations } from "next-intl/server";

export default async function ConnectorsSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const t = await getTranslations("connectorSettings");

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold">{t("pageTitle")}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t("pageDescription")}
        </p>
      </div>

      <ConnectorAppList />

      <div className="border-t pt-6">
        <PermissionManager />
      </div>
    </div>
  );
}
