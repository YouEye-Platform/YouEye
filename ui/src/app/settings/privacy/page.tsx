/**
 * Privacy Settings Page
 *
 * Manages encryption PIN and inter-app communication preferences.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { PINManager } from "@/components/settings/pin-manager";
import { getTranslations } from "next-intl/server";

export default async function PrivacySettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const t = await getTranslations('privacySettings');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t('description')}
        </p>
      </div>

      <PINManager />
    </div>
  );
}
