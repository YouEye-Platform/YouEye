/**
 * Proxy Settings Component
 *
 * Displays a read-only table of Caddy reverse proxy routes.
 * Shows domain, upstream, and TLS status for each route.
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ArrowLeftRight,
  Lock,
  LockOpen,
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
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { BridgeUnavailable } from "@/components/settings/admin/bridge-unavailable";
import type { ProxyRoute } from "@/lib/admin/types";

export function ProxySettings() {
  const t = useTranslations("settings.proxy");
  const tc = useTranslations("common");
  const [routes, setRoutes] = useState<ProxyRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchRoutes = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/admin/proxy/routes");
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json = await res.json();
      setRoutes(json.routes ?? []);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load proxy routes"
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchRoutes();
  }, [fetchRoutes]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchRoutes();
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Caddy reverse proxy routes.
          </p>
        </div>
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
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
            Caddy reverse proxy routes.
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
            Caddy reverse proxy routes (read-only). Manage routes in the Control
            Panel.
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

      {routes.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <ArrowLeftRight className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No proxy routes configured.
          </p>
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Domain</TableHead>
                <TableHead>Upstream</TableHead>
                <TableHead>TLS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {routes.map((route) => (
                <TableRow key={route.id}>
                  <TableCell className="font-medium">
                    {route.match_domain}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {route.upstream}
                  </TableCell>
                  <TableCell>
                    {route.tls_enabled ? (
                      <Badge className="bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20">
                        <Lock className="h-3 w-3" />
                        Enabled
                      </Badge>
                    ) : (
                      <Badge variant="secondary">
                        <LockOpen className="h-3 w-3" />
                        Disabled
                      </Badge>
                    )}
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
