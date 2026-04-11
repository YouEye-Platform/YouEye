/**
 * Container Management Settings
 *
 * Displays a table of Incus containers with start/stop/restart actions.
 * Auto-refreshes every 30 seconds.
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Box,
  Play,
  Square,
  RotateCcw,
  RefreshCw,
  Loader2,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "next-intl";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { BridgeUnavailable } from "@/components/settings/admin/bridge-unavailable";
import type { ContainerInfo } from "@/lib/admin/types";

/** Auto-refresh interval (30 seconds) */
const REFRESH_INTERVAL = 30_000;

/** Status badge color mapping */
function statusBadge(status: ContainerInfo["status"]) {
  switch (status) {
    case "Running":
      return <Badge className="bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20">{status}</Badge>;
    case "Stopped":
      return <Badge variant="secondary">{status}</Badge>;
    case "Error":
      return <Badge variant="destructive">{status}</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export function ContainerSettings() {
  const t = useTranslations("settings.containers");
  const tc = useTranslations("common");
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchContainers = useCallback(async (silent = false) => {
    try {
      if (!silent) setError(null);
      const res = await fetch("/api/admin/containers");
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json = await res.json();
      setContainers(json.containers ?? []);
      setError(null);
    } catch (err) {
      if (!silent) {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load containers"
        );
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Initial fetch and auto-refresh
  useEffect(() => {
    fetchContainers();

    intervalRef.current = setInterval(() => {
      fetchContainers(true);
    }, REFRESH_INTERVAL);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchContainers]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchContainers();
  };

  const handleAction = async (
    containerName: string,
    action: "start" | "stop" | "restart"
  ) => {
    setActionLoading(`${containerName}-${action}`);
    try {
      const res = await fetch(`/api/admin/containers/${containerName}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Action failed" }));
        console.error(`Container ${action} failed:`, body.error);
      }

      // Refresh the list after action
      await fetchContainers();
    } catch (err) {
      console.error(`Container ${action} error:`, err);
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Manage Incus containers.
          </p>
        </div>
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
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
            Manage Incus containers.
          </p>
        </div>
        <BridgeUnavailable message={error} onRetry={handleRefresh} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Manage Incus containers. Auto-refreshes every 30 seconds.
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
          Refresh
        </Button>
      </div>

      {containers.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <Box className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No containers found.
          </p>
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>IPv4</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {containers.map((container) => (
                <TableRow key={container.name}>
                  <TableCell className="font-medium">
                    {container.name}
                  </TableCell>
                  <TableCell>{statusBadge(container.status)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {container.ipv4 ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {container.type}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {container.status === "Stopped" && (
                        <ActionButton
                          containerName={container.name}
                          action="start"
                          icon={<Play className="h-3.5 w-3.5" />}
                          label="Start"
                          loading={actionLoading === `${container.name}-start`}
                          onAction={handleAction}
                        />
                      )}
                      {container.status === "Running" && (
                        <>
                          <ActionButton
                            containerName={container.name}
                            action="stop"
                            icon={<Square className="h-3.5 w-3.5" />}
                            label="Stop"
                            loading={actionLoading === `${container.name}-stop`}
                            onAction={handleAction}
                            destructive
                          />
                          <ActionButton
                            containerName={container.name}
                            action="restart"
                            icon={<RotateCcw className="h-3.5 w-3.5" />}
                            label="Restart"
                            loading={actionLoading === `${container.name}-restart`}
                            onAction={handleAction}
                          />
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/** Action button with confirmation dialog */
function ActionButton({
  containerName,
  action,
  icon,
  label,
  loading,
  destructive,
  onAction,
}: {
  containerName: string;
  action: "start" | "stop" | "restart";
  icon: React.ReactNode;
  label: string;
  loading: boolean;
  destructive?: boolean;
  onAction: (name: string, action: "start" | "stop" | "restart") => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant={destructive ? "destructive" : "outline"}
          size="sm"
          disabled={loading}
          className="h-7 px-2 text-xs"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            icon
          )}
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {label} container &ldquo;{containerName}&rdquo;?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {action === "stop"
              ? `This will stop the "${containerName}" container. Any services running inside will become unavailable.`
              : action === "restart"
                ? `This will restart the "${containerName}" container. Services will be briefly unavailable during restart.`
                : `This will start the "${containerName}" container.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => onAction(containerName, action)}
            className={destructive ? "bg-destructive text-white hover:bg-destructive/90" : ""}
          >
            {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
