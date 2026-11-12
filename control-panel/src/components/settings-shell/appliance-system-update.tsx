"use client";

import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CoreSystemUpdate } from "./core-system-update";
import type { CoreUpdateStatus } from "@/lib/spine/client";

export function ApplianceSystemUpdate() {
  const translateInterface = useInterfaceTranslations("interface");

  const [core, setCore] = useState<CoreUpdateStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/settings/api/appliance/core-update/status", { cache: "no-store", signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok || typeof body.managed !== "boolean") throw new Error(translateInterface("mc87dd5a532c0"));
      setCore(body);
    }).catch(cause => { if (!controller.signal.aborted) setError(translateInterface("mc87dd5a532c0")); });
    return () => controller.abort();
  }, []);
  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!core) return <p className="text-sm text-muted-foreground" role="status">{translateInterface("mdd27c3d0bc9e")}</p>;
  // Installations without a complete System release cannot be updated from
  // here; they are reinstalled. The Control Panel never selects a host source.
  return core.managed ? <CoreSystemUpdate initial={core} /> : <Alert><AlertDescription>{translateInterface("mc87dd5a532c0")}</AlertDescription></Alert>;
}
