"use client";

import {useLocale} from "next-intl";



import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ChevronRight, Loader2, RefreshCw, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
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

// Red only for urgent; amber for what needs attention; information (an app that restarted itself) stays grey.
const SEVERITY_META: Record<Severity, { labelKey: string; dot: string }> = {
  info: { labelKey: "notice", dot: "bg-muted-foreground" },
  warning: { labelKey: "m44e8b60922e3", dot: "bg-yellow-400" },
  error: { labelKey: "mc1ebc7817870", dot: "bg-amber-500" },
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

const SEVERITY_ORDER: Severity[] = ["critical", "error", "warning", "info"];

/** Issues that say the same thing ("notes restarted automatically", three times) are one entry. */
interface Entry {
  key: string;
  severity: Severity;
  /** The most recent occurrence: the entry shows it and its actions. */
  latest: HealthIssue;
  earlier: HealthIssue[];
  times: number;
}

interface Category { labelKey: string; entries: Entry[] }

function rank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/** Groups issues under their category, collapsing the ones with the same title; worst first. */
function groupIssues(issues: HealthIssue[]): Category[] {
  const categories = new Map<string, Map<string, HealthIssue[]>>();
  for (const issue of issues) {
    const labelKey = sourceName(issue.source);
    const byTitle = categories.get(labelKey) ?? new Map<string, HealthIssue[]>();
    byTitle.set(issue.title, [...(byTitle.get(issue.title) ?? []), issue]);
    categories.set(labelKey, byTitle);
  }
  const result: Category[] = [];
  for (const [labelKey, byTitle] of categories) {
    const entries: Entry[] = [];
    for (const [title, items] of byTitle) {
      const sorted = [...items].sort((left, right) => new Date(right.lastSeen).getTime() - new Date(left.lastSeen).getTime());
      entries.push({
        key: `${labelKey}:${title}`,
        severity: sorted.reduce<Severity>((worst, item) => (rank(item.severity) < rank(worst) ? item.severity : worst), sorted[0].severity),
        latest: sorted[0],
        earlier: sorted.slice(1),
        times: sorted.reduce((sum, item) => sum + Math.max(item.count || 1, 1), 0),
      });
    }
    entries.sort((left, right) => rank(left.severity) - rank(right.severity));
    result.push({ labelKey, entries });
  }
  return result.sort((left, right) => rank(left.entries[0].severity) - rank(right.entries[0].severity));
}

export function HealthClient() {
  const locale = useLocale();

  const translateInterface = useInterfaceTranslations("interface");
  const t = useInterfaceTranslations("settingsSystem");

  const [data, setData] = useState<IssuesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [ignoreReasons, setIgnoreReasons] = useState<Record<string, string>>({});
  // The issue whose "ignore" reason is being written; the field shows only then, not on every issue.
  const [ignoring, setIgnoring] = useState<string | null>(null);
  // Entries whose earlier occurrences are shown.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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
  const open = data?.summary?.open ?? 0;
  const openCategories = groupIssues(issues.filter((issue) => issue.state === "open"));
  const ignoredCategories = groupIssues(issues.filter((issue) => issue.state === "ignored"));
  const ignoredCount = issues.filter((issue) => issue.state === "ignored").length;
  const when = (value: string) => new Date(value).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  const counts = [
    { severity: "critical" as const, count: data?.summary?.critical ?? 0, key: "health.urgent" },
    { severity: "error" as const, count: data?.summary?.error ?? 0, key: "health.attention" },
    { severity: "warning" as const, count: data?.summary?.warning ?? 0, key: "health.checkSoon" },
    { severity: "info" as const, count: data?.summary?.info ?? 0, key: "health.info" },
  ].filter((item) => item.count > 0);

  /** Try safe fix and "Ignore for now…" for one issue; the reason field opens under the entry. */
  function actions(issue: HealthIssue) {
    if (issue.state !== "open") return null;
    return (
      <div className="flex flex-wrap gap-2 md:shrink-0 md:justify-end">
        {issue.fixable ? (
          <Button size="sm" variant="outline" onClick={() => act(issue.id, "fix")} disabled={busy === issue.id}>
            {busy === issue.id ? <Loader2 className="size-4 animate-spin" /> : <Wrench className="size-4" />}
            {translateInterface("m47e55d0f03be")}</Button>
        ) : null}
        {ignoring !== issue.id ? (
          <Button size="sm" variant="ghost" onClick={() => setIgnoring(issue.id)} disabled={busy === issue.id}>
            {translateInterface("mf3e6d43e312f")}…</Button>
        ) : null}
      </div>
    );
  }

  function ignoreForm(issue: HealthIssue) {
    if (issue.state !== "open" || ignoring !== issue.id) return null;
    return (
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input
          autoFocus
          className="min-w-0 sm:flex-1"
          aria-label={translateInterface("m7a286c59b5b2", { value0: String(issue.title) })}
          placeholder={translateInterface("mc245aaf74416")}
          value={ignoreReasons[issue.id] ?? ""}
          onChange={(event) => setIgnoreReasons((previous) => ({ ...previous, [issue.id]: event.target.value }))}
        />
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" className="flex-1 sm:flex-none" onClick={() => setIgnoring(null)}>{translateInterface("m19766ed6ccb2")}</Button>
          <Button size="sm" variant="outline" className="flex-1 sm:flex-none" onClick={() => act(issue.id, "ignore")} disabled={busy === issue.id}>
            {translateInterface("mf3e6d43e312f")}</Button>
        </div>
      </div>
    );
  }

  function entryRow(entry: Entry) {
    const { latest, earlier } = entry;
    const ignored = latest.state === "ignored";
    const meta = SEVERITY_META[entry.severity];
    const showEarlier = expanded.has(entry.key);
    return (
      <li key={entry.key} className="px-4 py-3.5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-6">
          <div className="min-w-0">
            <h3 className="text-[15px] font-medium leading-snug text-foreground">{latest.title}</h3>
            <p className="mt-0.5 max-w-2xl text-[13px] leading-5 text-muted-foreground">{latest.body}</p>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                <span className={`size-2 shrink-0 rounded-full ${ignored ? "bg-muted-foreground" : meta.dot}`} aria-hidden />
                {ignored ? translateInterface("m7d648f5b47f3") : meta.labelKey === "notice" ? t("health.notice") : translateInterface(meta.labelKey)}
              </span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">
                {entry.times > 1 ? t("health.repeated", { count: entry.times, date: when(latest.lastSeen) }) : t("health.lastSeen", { date: when(latest.lastSeen) })}
              </span>
            </p>
            {ignored && latest.ignoredReason ? (
              <p className="mt-1 text-xs text-muted-foreground">{t("health.ignoredBecause", { reason: latest.ignoredReason })}</p>
            ) : null}
          </div>
          {actions(latest)}
        </div>
        {ignoreForm(latest)}
        {earlier.length > 0 ? (
          <div className="mt-1">
            <button
              type="button"
              className="-ml-1 inline-flex min-h-9 items-center gap-1 rounded-md px-1 text-[13px] font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11"
              aria-expanded={showEarlier}
              onClick={() => setExpanded((previous) => {
                const next = new Set(previous);
                if (next.has(entry.key)) next.delete(entry.key); else next.add(entry.key);
                return next;
              })}
            >
              <ChevronRight className={`size-4 text-muted-foreground transition-transform ${showEarlier ? "rotate-90" : ""}`} aria-hidden />
              {t("health.earlier", { count: earlier.length })}
            </button>
            {showEarlier ? (
              <ul className="mt-1 divide-y border-t">
                {earlier.map((issue) => (
                  <li key={issue.id} className="py-2.5">
                    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-6">
                      <div className="min-w-0 text-[13px] text-muted-foreground">
                        <p className="tabular-nums text-foreground">{when(issue.lastSeen)}{issue.count > 1 ? ` · ${translateInterface("mcaa568c18c3b", { count: issue.count })}` : ""}</p>
                        {issue.body !== latest.body ? <p className="mt-0.5 max-w-2xl leading-5">{issue.body}</p> : null}
                        {issue.state === "ignored" && issue.ignoredReason ? <p className="mt-0.5 text-xs">{t("health.ignoredBecause", { reason: issue.ignoredReason })}</p> : null}
                      </div>
                      {actions(issue)}
                    </div>
                    {ignoreForm(issue)}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  }

  return (
    <div>
      <PageHeader
        title={translateInterface("m55898449eb74")}
        description={translateInterface("m6a4ccb93cfcd")}
      />

      <div className="mb-6" role="status">
        {loading && !data ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {translateInterface("mac436ef838f4")}</p>
        ) : open === 0 ? (
          <p className="flex items-start gap-2.5 text-sm">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <span><span className="font-medium">{translateInterface("m62ec6b1a3080")}</span>{" "}<span className="text-muted-foreground">{translateInterface("mb8f5d018f123")}</span></span>
          </p>
        ) : (
          <ul className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm font-medium tabular-nums">
            {counts.map((item) => (
              <li key={item.severity} className="inline-flex items-center gap-2">
                <span className={`size-2 shrink-0 rounded-full ${SEVERITY_META[item.severity].dot}`} aria-hidden />
                {t(item.key, { count: item.count })}
              </li>
            ))}
          </ul>
        )}
      </div>

      {error ? (
        <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-card px-4 py-3 text-sm">
          <span className="min-w-0">{error}</span>
          <Button size="sm" variant="outline" className="shrink-0" onClick={load}><RefreshCw className="size-4" />{translateInterface("md8b8392e2c54")}</Button>
        </div>
      ) : null}
      {message ? <div role="status" className="mb-4 rounded-lg border bg-muted/50 px-4 py-3 text-sm">{message}</div> : null}

      <div className="space-y-6">
        {openCategories.map((category) => (
          <section key={category.labelKey}>
            <h2 className="mb-2 px-1 text-[15px] font-semibold text-foreground">{translateInterface(category.labelKey)}</h2>
            <ul className="settings-group">{category.entries.map(entryRow)}</ul>
          </section>
        ))}

        {ignoredCount > 0 ? (
          <details className="group">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md text-[15px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
              {t("health.ignoredGroup", { count: ignoredCount })}
            </summary>
            <div className="mt-2 space-y-5">
              {ignoredCategories.map((category) => (
                <section key={category.labelKey}>
                  <h2 className="mb-2 px-1 text-[13px] font-medium text-muted-foreground">{translateInterface(category.labelKey)}</h2>
                  <ul className="settings-group">{category.entries.map(entryRow)}</ul>
                </section>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}
