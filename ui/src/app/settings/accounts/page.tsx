import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AccountsSettings } from "@/components/settings/accounts-settings";
import { getTranslations } from "next-intl/server";

export default async function AccountsSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const t = await getTranslations("accountSettings");

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold">{t("pageTitle")}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t("pageDescription")}
        </p>
      </div>

      <AccountsSettings />
    </div>
  );
}
