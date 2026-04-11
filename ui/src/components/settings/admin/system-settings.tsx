/**
 * System Settings Component
 *
 * Displays host info, CPU/memory/disk usage, and container summary
 * fetched from the Control Panel bridge API.
 * Shows loading skeletons while fetching and gracefully handles
 * CP unavailability.
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Server,
  Cpu,
  HardDrive,
  MemoryStick,
  Box,
  RefreshCw,
  Loader2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BridgeUnavailable } from "@/components/settings/admin/bridge-unavailable";
import type { SystemInfo } from "@/lib/admin/types";

/** Progress bar component for usage stats */
function UsageBar({
  label,
  used,
  total,
  unit,
}: {
  label: string;
  used: number;
  total: number;
  unit: string;
}) {
  const percent = total > 0 ? Math.round((used / total) * 100) : 0;
  const barColor =
    percent > 90
      ? "bg-destructive"
      : percent > 70
        ? "bg-amber-500"
        : "bg-primary";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">
          {used.toLocaleString()} / {total.toLocaleString()} {unit} ({percent}%)
        </span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
    </div>
  );
}

export function SystemSettings() {
  const t = useTranslations("settings.system");
  const tc = useTranslations("common");
  const [data, setData] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/admin/system");
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json: SystemInfo = await res.json();
      setData(json);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load system information"
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchData();
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {t("description")}
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-4 w-24" />
              </CardHeader>
              <CardContent className="space-y-3">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {t("description")}
          </p>
        </div>
        <BridgeUnavailable message={error} onRetry={handleRefresh} />
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {t("description")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          {refreshing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {tc("refresh")}
        </Button>
      </div>

      {/* Host Info */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-4 w-4" />
            {t("hostname")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
            <div>
              <span className="text-muted-foreground">Hostname</span>
              <p className="font-medium">{data.hostname}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Operating System</span>
              <p className="font-medium">{data.os}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Kernel</span>
              <p className="font-medium">{data.kernel}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Uptime</span>
              <p className="font-medium">{data.uptime}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Resource Usage */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* CPU */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Cpu className="h-4 w-4" />
              CPU
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div>
              <span className="text-muted-foreground">Model</span>
              <p className="font-medium">{data.cpu.model}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Cores</span>
              <p className="font-medium">{data.cpu.cores}</p>
            </div>
          </CardContent>
        </Card>

        {/* Memory */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <MemoryStick className="h-4 w-4" />
              Memory
            </CardTitle>
          </CardHeader>
          <CardContent>
            <UsageBar
              label="RAM"
              used={data.memory.used_mb}
              total={data.memory.total_mb}
              unit="MB"
            />
          </CardContent>
        </Card>

        {/* Disk */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <HardDrive className="h-4 w-4" />
              Disk
            </CardTitle>
          </CardHeader>
          <CardContent>
            <UsageBar
              label="Storage"
              used={data.disk.used_gb}
              total={data.disk.total_gb}
              unit="GB"
            />
          </CardContent>
        </Card>

        {/* Containers */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Box className="h-4 w-4" />
              Containers
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-3 text-sm">
              <span className="text-muted-foreground">Incus</span>
              <Badge variant="secondary">{data.incus.version}</Badge>
              <span className="text-muted-foreground">
                Pool: {data.incus.storage_pool}
              </span>
            </div>
            <div className="flex items-center gap-4 text-sm">
              <div className="flex items-center gap-1.5">
                <div className="h-2 w-2 rounded-full bg-primary" />
                <span>{data.containers.total} Total</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-2 w-2 rounded-full bg-green-500" />
                <span>{data.containers.running} Running</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-2 w-2 rounded-full bg-muted-foreground" />
                <span>{data.containers.stopped} Stopped</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
