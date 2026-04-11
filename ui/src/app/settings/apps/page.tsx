/**
 * Apps Settings Page
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { PermissionManager } from "@/components/settings/permission-manager";
import { getTranslations } from "next-intl/server";

export default async function AppsSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const t = await getTranslations('appsSettings');

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t('description')}
        </p>
      </div>

      <PermissionManager />

      <div className="border-t pt-6">
        <p className="text-sm text-muted-foreground">
          {t('drawerNote')}
        </p>
      </div>
    </div>
  );
}
