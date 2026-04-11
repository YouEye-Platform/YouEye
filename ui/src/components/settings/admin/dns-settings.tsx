/**
 * DNS Settings Component
 *
 * Displays Pi-Hole DNS stats: queries, blocked, gravity size.
 * Shows top queries and top blocked domains.
 * Toggle button for enabling/disabling Pi-Hole.
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Globe,
  ShieldCheck,
  ShieldOff,
  Search,
  Ban,
  RefreshCw,
  Loader2,
  Activity,
  Database,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { BridgeUnavailable } from "@/components/settings/admin/bridge-unavailable";
import type { DnsStats } from "@/lib/admin/types";

export function DnsSettings() {
  const t = useTranslations("settings.dns");
  const tc = useTranslations("common");
  const [data, setData] = useState<DnsStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [toggling, setToggling] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/admin/dns/stats");
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json: DnsStats = await res.json();
      setData(json);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load DNS statistics"
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

  const handleToggle = async () => {
    if (!data) return;
    setToggling(true);

    const newAction = data.status === "enabled" ? "disable" : "enable";

    try {
      const res = await fetch("/api/admin/dns/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: newAction }),
      });

      if (res.ok) {
        const result = await res.json();
        setData((prev) => (prev ? { ...prev, status: result.status } : prev));
      }
    } catch (err) {
      console.error("DNS toggle error:", err);
    } finally {
      setToggling(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Pi-Hole DNS filtering statistics.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-6">
                <Skeleton className="h-4 w-20 mb-2" />
                <Skeleton className="h-8 w-16" />
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
            Pi-Hole DNS filtering statistics.
          </p>
        </div>
        <BridgeUnavailable message={error} onRetry={handleRefresh} />
      </div>
    );
  }

  if (!data) return null;

  const isEnabled = data.status === "enabled";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Pi-Hole DNS filtering statistics.
          </p>
        </div>
        <div className="flex items-center gap-2">
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
      </div>

      {/* Status + Toggle */}
      <Card>
        <CardContent className="flex items-center justify-between py-4">
          <div className="flex items-center gap-3">
            {isEnabled ? (
              <ShieldCheck className="h-5 w-5 text-green-500" />
            ) : (
              <ShieldOff className="h-5 w-5 text-destructive" />
            )}
            <div>
              <p className="font-medium">
                Pi-Hole is{" "}
                <Badge
                  className={
                    isEnabled
                      ? "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20"
                      : "bg-destructive/10 text-destructive border-destructive/20"
                  }
                >
                  {isEnabled ? "Enabled" : "Disabled"}
                </Badge>
              </p>
            </div>
          </div>
          <Button
            variant={isEnabled ? "destructive" : "default"}
            size="sm"
            onClick={handleToggle}
            disabled={toggling}
          >
            {toggling ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isEnabled ? (
              <ShieldOff className="h-4 w-4" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            {isEnabled ? "Disable" : "Enable"}
          </Button>
        </CardContent>
      </Card>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Activity className="h-4 w-4" />
              {t("queries")}
            </div>
            <p className="text-2xl font-bold">
              {data.queries_today.toLocaleString()}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Ban className="h-4 w-4" />
              {t("blocked")}
            </div>
            <p className="text-2xl font-bold">
              {data.blocked_today.toLocaleString()}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <ShieldCheck className="h-4 w-4" />
              Block Percentage
            </div>
            <p className="text-2xl font-bold">
              {data.percent_blocked.toFixed(1)}%
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Database className="h-4 w-4" />
              {t("gravity")}
            </div>
            <p className="text-2xl font-bold">
              {data.gravity_size.toLocaleString()}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Top Queries & Top Blocked */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Top Queries */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Search className="h-4 w-4" />
              {t("topQueries")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.top_queries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {tc("noResults")}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Domain</TableHead>
                    <TableHead className="text-right">Count</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.top_queries.map((q) => (
                    <TableRow key={q.domain}>
                      <TableCell className="font-mono text-xs">
                        {q.domain}
                      </TableCell>
                      <TableCell className="text-right">
                        {q.count.toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Top Blocked */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe className="h-4 w-4" />
              {t("topBlocked")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.top_blocked.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {tc("noResults")}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Domain</TableHead>
                    <TableHead className="text-right">Count</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.top_blocked.map((q) => (
                    <TableRow key={q.domain}>
                      <TableCell className="font-mono text-xs">
                        {q.domain}
                      </TableCell>
                      <TableCell className="text-right">
                        {q.count.toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
