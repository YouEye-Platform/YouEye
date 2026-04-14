/**
 * Backup Settings Component
 *
 * Streams backup configuration and history from the Control Panel
 * via the admin bridge API. Supports:
 * - Viewing backup schedule configuration
 * - Viewing backup history (core + per-app)
 * - Triggering manual backups
 * - Restoring from backup points
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import {
  HardDrive,
  Shield,
  Clock,
  Archive,
  Calendar,
  RotateCcw,
  RefreshCw,
  Loader2,
  Check,
  AlertCircle,
  ExternalLink,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BridgeUnavailable } from "@/components/settings/admin/bridge-unavailable";

interface BackupIndexEntry {
  timestamp: string;
  archive_path: string;
  archive_size: number;
  version: string;
}

interface BackupData {
  config: {
    enabled: boolean;
    target_path: string;
    schedule: {
      core: { frequency: string; retention: number; time: string; last_run?: string };
      default_app: { frequency: string; retention: number };
      overrides: Record<string, { frequency: string; retention: number }>;
    };
  };
  index: {
    last_updated: string;
    core: BackupIndexEntry[];
    apps: Record<string, BackupIndexEntry[]>;
  } | null;
  apps: Array<{ appId: string; type: string; subdomain?: string }>;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function timeAgo(ts: string): string {
  try {
    const diffMs = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  } catch {
    return "";
  }
}

export function BackupSettings() {
  const [data, setData] = useState<BackupData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/backup");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchData();
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (error && !data) {
    return <BridgeUnavailable />;
  }

  if (!data) return null;

  const { config, index, apps } = data;
  const totalBackups =
    (index?.core?.length ?? 0) +
    Object.values(index?.apps ?? {}).reduce((sum, arr) => sum + arr.length, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Backup & Restore</h2>
          <p className="text-sm text-muted-foreground">
            Manage automated backups and restore individual apps or the full platform.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href="/api/admin/backup" target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4 mr-1" />
              Open in Control Panel
            </a>
          </Button>
        </div>
      </div>

      {/* Status overview */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              {config.enabled ? (
                <Check className="h-5 w-5 text-green-500" />
              ) : (
                <AlertCircle className="h-5 w-5 text-amber-500" />
              )}
              <div>
                <p className="text-sm font-medium">
                  {config.enabled ? "Backups Active" : "Backups Not Configured"}
                </p>
                <p className="text-xs text-muted-foreground">{config.target_path}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <Archive className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{totalBackups} Backup{totalBackups !== 1 ? "s" : ""}</p>
                <p className="text-xs text-muted-foreground">
                  {index?.last_updated ? `Last: ${timeAgo(index.last_updated)}` : "No backups yet"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <Clock className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">
                  Core: {config.schedule.core.frequency}
                </p>
                <p className="text-xs text-muted-foreground">
                  at {config.schedule.core.time},{" "}
                  keep {config.schedule.core.retention}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Schedule summary */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4" />
            Backup Schedule
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex items-center gap-3 text-sm py-2 px-3 rounded border bg-muted/30">
              <Shield className="h-4 w-4 text-blue-500 flex-shrink-0" />
              <span className="font-medium w-32">Core Platform</span>
              <Badge variant="outline">{config.schedule.core.frequency}</Badge>
              <span className="text-muted-foreground">
                at {config.schedule.core.time}, keep {config.schedule.core.retention}
              </span>
              {config.schedule.core.last_run && (
                <span className="ml-auto text-xs text-muted-foreground">
                  Last: {timeAgo(config.schedule.core.last_run)}
                </span>
              )}
            </div>

            {apps.map((app) => {
              const override = config.schedule.overrides[app.appId];
              const freq = override?.frequency || config.schedule.default_app.frequency;
              const ret = override?.retention || config.schedule.default_app.retention;

              return (
                <div
                  key={app.appId}
                  className="flex items-center gap-3 text-sm py-2 px-3 rounded border"
                >
                  <HardDrive className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span className="font-medium w-32">{app.appId}</span>
                  <Badge variant={freq === "never" ? "secondary" : "outline"}>
                    {freq}
                  </Badge>
                  {freq !== "never" && (
                    <span className="text-muted-foreground">keep {ret}</span>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Backup history */}
      {index && (
        <>
          {/* Core backups */}
          {(index.core?.length ?? 0) > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Shield className="h-4 w-4" />
                  Core Backups
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {index.core.map((entry, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 text-sm py-2 px-3 rounded border"
                    >
                      <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span className="flex-1">{formatTimestamp(entry.timestamp)}</span>
                      <Badge variant="outline">{formatBytes(entry.archive_size)}</Badge>
                      {entry.version && <Badge variant="secondary">v{entry.version}</Badge>}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Per-app backups */}
          {Object.entries(index.apps || {}).map(([appId, entries]) =>
            entries.length > 0 ? (
              <Card key={appId}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Archive className="h-4 w-4" />
                    {appId}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {entries.map((entry, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 text-sm py-2 px-3 rounded border"
                      >
                        <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        <span className="flex-1">{formatTimestamp(entry.timestamp)}</span>
                        <Badge variant="outline">{formatBytes(entry.archive_size)}</Badge>
                        {entry.version && <Badge variant="secondary">v{entry.version}</Badge>}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ) : null
          )}
        </>
      )}
    </div>
  );
}
