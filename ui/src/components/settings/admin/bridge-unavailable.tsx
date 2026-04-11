/**
 * Bridge Unavailable Card
 *
 * Displayed when the Control Panel bridge API is unreachable.
 * Shows a friendly message with a retry button.
 */

"use client";

import { useTranslations } from "next-intl";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface BridgeUnavailableProps {
  message?: string;
  onRetry?: () => void;
}

export function BridgeUnavailable({
  message,
  onRetry,
}: BridgeUnavailableProps) {
  const t = useTranslations("bridgeUnavailable");
  const tc = useTranslations("common");

  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardContent className="flex flex-col items-center gap-4 py-8 text-center">
        <div className="rounded-full bg-amber-500/10 p-3">
          <AlertTriangle className="h-6 w-6 text-amber-500" />
        </div>
        <div className="space-y-1">
          <p className="font-medium text-amber-600 dark:text-amber-400">
            {t("title")}
          </p>
          <p className="text-sm text-muted-foreground max-w-md">{message || t("description")}</p>
        </div>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="h-4 w-4" />
            {tc("retry")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
