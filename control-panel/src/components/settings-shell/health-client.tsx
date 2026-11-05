"use client";

import {useLocale} from "next-intl";



import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Clock3, Loader2, RefreshCw, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/settings-shell/page-header";

type Severity = "info" | "warning" | "error" | "critical";
type IssueState = "open" | "ignored" | "resolved";

interface HealthIssue {
  id: string;
  severity: Severity;
  source: string;
  title: string;
  body: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  fixable: boolean;
  state: IssueState;
  ignoredReason?: string | null;
}

interface IssuesResponse {
  issues: HealthIssue[];
  summary: Record<string, number>;
}

const SEVERITY_META: Record<Severity, { labelKey: string; dot: string }> = {
  info: { labelKey: "mc1c1009d3f37", dot: "bg-muted-foreground" },
  warning: { labelKey: "m44e8b60922e3", dot: "bg-amber-500" },
  error: { labelKey: "mc1ebc7817870", dot: "bg-destructive" },
  critical: { labelKey: "m1b015904cc17", dot: "bg-destructive" },
};

const SOURCE_NAMES: Record<string, string> = {
  system: "m6725e7bbcd28",
  "health-monitor": "m6b5fc20a0a97",
  watchdog: "m6b5fc20a0a97",
  "disk-watcher": "ma69c4dece144",
  "memory-watcher": "mc3963aedaac6",
  "app-prober": "m98e33b0f3104",
  reconcile: "m95b958ec1144",
};

function sourceName(source: string): string {
  return SOURCE_NAMES[source] ?? "m6725e7bbcd28";
}

function Status({ severity, state }: { severity: Severity; state: IssueState }) {
  const translateInterface = useInterfaceTranslations("interface");

  if (state === "ignored") {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <span className="size-2 rounded-full bg-muted-foreground" aria-hidden />
        {translateInterface("m7d648f5b47f3")}</span>
    );
  }
  const meta = SEVERITY_META[severity];
  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
      <span className={`size-2 rounded-full ${meta.dot}`} aria-hidden />
      {translateInterface(meta.labelKey)}
    </span>
  );
}

export function HealthClient() {
  const locale = useLocale();

  const translateInterface = useInterfaceTranslations("interface");

  const [data, setData] = useState<IssuesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [ignoreReasons, setIgnoreReasons] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/health/issues");
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || translateInterface("md68a2620eebf"));
      setData(body as IssuesResponse);
    } catch (loadError) {
      setError(translateInterface("md68a2620eebf"));
    } finally {
      setLoading(false);
    }
  }, [translateInterface]);

  useEffect(() => {
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  async function act(id: string, action: "fix" | "ignore") {
    setBusy(id);
    setMessage("");
    setError("");
    try {
      const res = await fetch("/api/health/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action, reason: ignoreReasons[id] }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || body.error || translateInterface("mc8246aaad279"));
      setMessage(body.message || (action === "ignore" ? translateInterface("mb3f8848b1e63") : translateInterface("m573cb37db33d")));
      await load();
    } catch (actionError) {
      setError(translateInterface("mc8246aaad279"));
    } finally {
      setBusy(null);
    }
  }

  const issues = data?.issues ?? [];
  const critical = data?.summary?.critical ?? 0;
  const open = data?.summary?.open ?? 0;

  return (
    <div>
      <PageHeader
        title={translateInterface("m55898449eb74")}
        description={translateInterface("m6a4ccb93cfcd")}
      />

      <Card className="mb-5 p-5">
        {loading && !data ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {translateInterface("mac436ef838f4")}</div>
        ) : open === 0 ? (
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 size-5 text-primary" />
            <div>
              <div className="font-medium">{translateInterface("m62ec6b1a3080")}</div>
              <p className="mt-1 text-sm text-muted-foreground">{translateInterface("mb8f5d018f123")}</p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2 font-medium">
                <span className={`size-2 rounded-full ${critical > 0 ? "bg-destructive" : "bg-amber-500"}`} aria-hidden />
                {critical > 0 ? translateInterface("m157ab397f698") : translateInterface("m2eccbef5d2be")}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {translateInterface("m27b1ff6b654f", {count: open})}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-5 text-sm">
              <div><div className="font-semibold">{critical}</div><div className="text-muted-foreground">{translateInterface("m1b015904cc17")}</div></div>
              <div><div className="font-semibold">{data?.summary?.error ?? 0}</div><div className="text-muted-foreground">{translateInterface("mc2eb8cd9d956")}</div></div>
              <div><div className="font-semibold">{data?.summary?.warning ?? 0}</div><div className="text-muted-foreground">{translateInterface("m44e8b60922e3")}</div></div>
            </div>
          </div>
        )}
      </Card>

      {error ? (
        <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-card px-4 py-3 text-sm">
          <span>{error}</span>
          <Button size="sm" variant="outline" onClick={load}><RefreshCw className="mr-2 size-4" />{translateInterface("md8b8392e2c54")}</Button>
        </div>
      ) : null}
      {message ? <div role="status" className="mb-4 rounded-lg border bg-muted/50 px-4 py-3 text-sm">{message}</div> : null}

      <div className="space-y-3">
        {issues.map((issue) => (
          <Card key={issue.id} className="p-5">
            <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <Status severity={issue.severity} state={issue.state} />
                  <span className="text-sm text-muted-foreground">{translateInterface(sourceName(issue.source))}</span>
                </div>
                <h2 className="mt-3 text-base font-semibold text-foreground">{issue.title}</h2>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{issue.body}</p>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5"><Clock3 className="size-3.5" />{translateInterface("m21fd79c7de52")}{new Date(issue.lastSeen).toLocaleString(locale)}</span>
                  {issue.count > 1 ? <span>{translateInterface("mcaa568c18c3b", {count: issue.count})}</span> : null}
                </div>
                {issue.state === "ignored" && issue.ignoredReason ? (
                  <p className="mt-3 text-xs text-muted-foreground">{translateInterface("m3159b2436e20")}{issue.ignoredReason}</p>
                ) : null}
              </div>

              {issue.state === "open" ? (
                <div className="flex w-full flex-col gap-2 md:w-64">
                  {issue.fixable ? (
                    <Button size="sm" onClick={() => act(issue.id, "fix")} disabled={busy === issue.id}>
                      {busy === issue.id ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Wrench className="mr-2 size-4" />}
                      {translateInterface("m47e55d0f03be")}</Button>
                  ) : null}
                  <Input
                    aria-label={translateInterface("m7a286c59b5b2", { value0: String(issue.title) })}
                    placeholder={translateInterface("mc245aaf74416")}
                    value={ignoreReasons[issue.id] ?? ""}
                    onChange={(event) => setIgnoreReasons((previous) => ({ ...previous, [issue.id]: event.target.value }))}
                  />
                  <Button size="sm" variant="outline" onClick={() => act(issue.id, "ignore")} disabled={busy === issue.id}>
                    {translateInterface("mf3e6d43e312f")}</Button>
                </div>
              ) : null}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
