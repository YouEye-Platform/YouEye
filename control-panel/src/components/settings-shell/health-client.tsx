"use client";

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

const SEVERITY_META: Record<Severity, { label: string; dot: string }> = {
  info: { label: "Update", dot: "bg-muted-foreground" },
  warning: { label: "Check soon", dot: "bg-amber-500" },
  error: { label: "Needs attention", dot: "bg-destructive" },
  critical: { label: "Urgent", dot: "bg-destructive" },
};

const SOURCE_NAMES: Record<string, string> = {
  system: "System",
  "health-monitor": "System services",
  watchdog: "System services",
  "disk-watcher": "Storage",
  "memory-watcher": "Memory",
  "app-prober": "Applications",
  reconcile: "Apps and connections",
};

function sourceName(source: string): string {
  return SOURCE_NAMES[source] ?? "System";
}

function Status({ severity, state }: { severity: Severity; state: IssueState }) {
  if (state === "ignored") {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <span className="size-2 rounded-full bg-muted-foreground" aria-hidden />
        Ignored
      </span>
    );
  }
  const meta = SEVERITY_META[severity];
  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
      <span className={`size-2 rounded-full ${meta.dot}`} aria-hidden />
      {meta.label}
    </span>
  );
}

export function HealthClient() {
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
      if (!res.ok) throw new Error(body.error || "Health information is unavailable");
      setData(body as IssuesResponse);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Health information is unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

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
      if (!res.ok) throw new Error(body.message || body.error || "The action could not be completed");
      setMessage(body.message || (action === "ignore" ? "Issue ignored" : "Repair completed"));
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "The action could not be completed");
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
        title="Health"
        description="A clear view of anything on your server that needs attention."
      />

      <Card className="mb-5 p-5">
        {loading && !data ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Checking your server…
          </div>
        ) : open === 0 ? (
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 size-5 text-primary" />
            <div>
              <div className="font-medium">Everything looks good</div>
              <p className="mt-1 text-sm text-muted-foreground">No current issues need your attention.</p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2 font-medium">
                <span className={`size-2 rounded-full ${critical > 0 ? "bg-destructive" : "bg-amber-500"}`} aria-hidden />
                {critical > 0 ? "Your server needs attention" : "A few things need checking"}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {open} open {open === 1 ? "item" : "items"}. Details and safe actions are listed below.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-5 text-sm">
              <div><div className="font-semibold">{critical}</div><div className="text-muted-foreground">Urgent</div></div>
              <div><div className="font-semibold">{data?.summary?.error ?? 0}</div><div className="text-muted-foreground">Attention</div></div>
              <div><div className="font-semibold">{data?.summary?.warning ?? 0}</div><div className="text-muted-foreground">Check soon</div></div>
            </div>
          </div>
        )}
      </Card>

      {error ? (
        <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-card px-4 py-3 text-sm">
          <span>{error}</span>
          <Button size="sm" variant="outline" onClick={load}><RefreshCw className="mr-2 size-4" />Try again</Button>
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
                  <span className="text-sm text-muted-foreground">{sourceName(issue.source)}</span>
                </div>
                <h2 className="mt-3 text-base font-semibold text-foreground">{issue.title}</h2>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{issue.body}</p>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5"><Clock3 className="size-3.5" />Last seen {new Date(issue.lastSeen).toLocaleString()}</span>
                  {issue.count > 1 ? <span>Seen {issue.count} times</span> : null}
                </div>
                {issue.state === "ignored" && issue.ignoredReason ? (
                  <p className="mt-3 text-xs text-muted-foreground">Ignored because: {issue.ignoredReason}</p>
                ) : null}
              </div>

              {issue.state === "open" ? (
                <div className="flex w-full flex-col gap-2 md:w-64">
                  {issue.fixable ? (
                    <Button size="sm" onClick={() => act(issue.id, "fix")} disabled={busy === issue.id}>
                      {busy === issue.id ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Wrench className="mr-2 size-4" />}
                      Try safe fix
                    </Button>
                  ) : null}
                  <Input
                    aria-label={`Reason for ignoring ${issue.title}`}
                    placeholder="Reason for ignoring"
                    value={ignoreReasons[issue.id] ?? ""}
                    onChange={(event) => setIgnoreReasons((previous) => ({ ...previous, [issue.id]: event.target.value }))}
                  />
                  <Button size="sm" variant="outline" onClick={() => act(issue.id, "ignore")} disabled={busy === issue.id}>
                    Ignore for now
                  </Button>
                </div>
              ) : null}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
