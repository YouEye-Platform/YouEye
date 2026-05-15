/**
 * Login Card Component
 *
 * Displays the SSO login button and any error messages.
 * Only authentication method is Authentik SSO.
 */

"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LogIn, AlertCircle } from "lucide-react";
import { useTranslations } from "next-intl";

interface LoginCardProps {
  error?: string;
  ssoConfigured: boolean;
  siteName?: string;
}

export function LoginCard({ error, ssoConfigured, siteName = 'YouEye' }: LoginCardProps) {
  const t = useTranslations('login');

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">{siteName}</CardTitle>
        <CardDescription>{t('signInDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <span>{decodeURIComponent(error)}</span>
          </div>
        )}

        {ssoConfigured ? (
          <Button asChild size="lg" className="w-full">
            <a href="/api/auth/sso">
              <LogIn className="size-4" />
              {t('signInWithAuthentik')}
            </a>
          </Button>
        ) : (
          <div className="rounded-md bg-muted p-4 text-center text-sm text-muted-foreground">
            {t('ssoNotConfigured')}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
