/**
 * Admin Access Denied
 *
 * Displayed when a non-admin user navigates to an admin-only page.
 */

"use client";

import { useTranslations } from "next-intl";
import { ShieldX } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export function AdminAccessDenied() {
  const t = useTranslations("accessDenied");
  const tn = useTranslations("nav");

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
        <div className="rounded-full bg-destructive/10 p-3">
          <ShieldX className="h-6 w-6 text-destructive" />
        </div>
        <div className="space-y-1">
          <p className="text-lg font-semibold">{t("title")}</p>
          <p className="text-sm text-muted-foreground max-w-md">
            {t("description")}
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/settings">{tn("settings")}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
