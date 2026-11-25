"use client";

import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useCallback, useEffect, useId, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { AppSection, groupClass, rowClass } from "./app-section";
import { type AppConnection, type ConnectionSuggestion, pendingSuggestionsFor, suggestionNames } from "./app-connections-model";

async function csrfToken(): Promise<string> {
  const res = await fetch("/settings/api/auth/csrf", { cache: "no-store" });
  if (!res.ok) throw new Error("csrf");
  return (await res.json()).csrfToken as string;
}

/** The server's own words when it gave them (they name the cause), else nothing. */
async function failureReason(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return typeof body?.error === "string" ? body.error : "";
}

/** The app's connections and the suggestions that concern it; `null` when either list could not be read. */
async function readConnections(appId: string): Promise<{ connections: AppConnection[]; suggestions: ConnectionSuggestion[] } | null> {
  try {
    const [bridgesRes, suggestionsRes] = await Promise.all([
      fetch(`/api/bridges?appId=${encodeURIComponent(appId)}`, { cache: "no-store" }),
      fetch("/api/suggestions", { cache: "no-store" }),
    ]);
    if (!bridgesRes.ok || !suggestionsRes.ok) return null;
    const bridges = await bridgesRes.json();
    const all = await suggestionsRes.json();
    return {
      connections: ((Array.isArray(bridges) ? bridges : bridges.bridges) ?? [])
        .filter((b: AppConnection) => b.from === appId || b.to === appId),
      suggestions: pendingSuggestionsFor(appId, Array.isArray(all) ? all : []),
    };
  } catch {
    return null;
  }
}

type Busy = { id: string; action: "approve" | "dismiss" | "disconnect" };

/**
 * The app page's Connections section (YE-227): the connections the app has, with Disconnect, and the suggested ones
 * that wait for a decision, with Approve and Dismiss. Approving is the same request as `youeye app connect`
 * (`POST /api/suggestions` with `approve`): it creates the connection, activates it and runs the consumer's connect
 * file. Nothing is shown as done before the server confirms it; a failure stays beside its row with the server's
 * reason.
 */
export function AppConnections({ appId, appName, nameOf }: {
  appId: string;
  appName: string;
  /** An installed app's display name, `undefined` for an app that is not installed. */
  nameOf: (id: string) => string | undefined;
}) {
  const translateInterface = useInterfaceTranslations("interface");
  const [connections, setConnections] = useState<AppConnection[]>([]);
  const [suggestions, setSuggestions] = useState<ConnectionSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<Busy | null>(null);
  // A failed change stays beside its row: our sentence, and the server's own words under it when it gave them.
  const [rowError, setRowError] = useState<{ id: string; detail: string } | null>(null);
  const rowIds = useId();
  const [confirm, setConfirm] = useState<AppConnection | null>(null);

  const show = useCallback((read: Awaited<ReturnType<typeof readConnections>>) => {
    if (read) {
      setConnections(read.connections);
      setSuggestions(read.suggestions);
    }
    setLoadFailed(!read);
    setLoading(false);
  }, []);
  const load = useCallback(async () => show(await readConnections(appId)), [appId, show]);

  useEffect(() => {
    let live = true;
    void readConnections(appId).then((read) => { if (live) show(read); });
    return () => { live = false; };
  }, [appId, show]);

  const fallback = translateInterface("m5b2cc4b8f41d");
  async function run(target: Busy, request: (csrf: string) => Promise<Response>) {
    if (busy) return;
    setBusy(target);
    setRowError(null);
    try {
      const res = await request(await csrfToken());
      if (!res.ok) setRowError({ id: target.id, detail: await failureReason(res) });
      // Read the lists again even after a failure: the change may have been made elsewhere (the CLI, another
      // admin), or half made (a connection created whose activation failed).
      await load();
    } catch {
      setRowError({ id: target.id, detail: "" });
    } finally {
      setBusy(null);
    }
  }

  const approve = (s: ConnectionSuggestion) => run({ id: s.id, action: "approve" }, (csrf) => fetch("/api/suggestions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify({ action: "approve", id: s.id }),
  }));
  const dismiss = (s: ConnectionSuggestion) => run({ id: s.id, action: "dismiss" }, (csrf) => fetch("/api/suggestions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify({ action: "dismiss", id: s.id }),
  }));
  const disconnect = (c: AppConnection) => run({ id: c.id, action: "disconnect" }, (csrf) => fetch(`/api/bridges/${encodeURIComponent(c.id)}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": csrf },
  }));

  const label = (id: string) => nameOf(id) ?? id;
  const errorFor = (id: string) => rowError?.id === id
    ? (
      <div role="alert" className="mt-1 text-[13px] text-destructive">
        <p className="flex items-center gap-1.5"><AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />{fallback}</p>
        {rowError.detail && <p className="mt-0.5 text-muted-foreground [overflow-wrap:anywhere]">{rowError.detail}</p>}
      </div>
    )
    : null;
  /** The row's title names both apps: each button of the row is described by it ("Approve", "Nextcloud can use …"). */
  const titleId = (id: string) => `${rowIds}-${id}`;
  const spinner = <Loader2 className="animate-spin" aria-hidden />;

  return (
    <AppSection id="connections" title={translateInterface("mdc273117482b")} description={translateInterface("m0c420ea290e0", { app: appName })}>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm ? translateInterface("m78148aaa805a", { from: label(confirm.from), to: label(confirm.to) }) : ""}
        description={confirm ? translateInterface("m6e6e13ff28bc", { from: label(confirm.from), to: label(confirm.to) }) : undefined}
        confirmLabel={translateInterface("macfc5be785a9")}
        destructive
        confirmDisabled={busy !== null}
        onCancel={() => setConfirm(null)}
        onConfirm={() => { const c = confirm; setConfirm(null); if (c) void disconnect(c); }}
      />
      {loading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">{spinner}{translateInterface("m47d2a515ef2f")}</div>
      ) : loadFailed ? (
        <p role="alert" className="flex items-center gap-2 py-2 text-sm text-muted-foreground"><AlertCircle className="h-4 w-4 shrink-0" aria-hidden />{translateInterface("mb9db095f614a")}</p>
      ) : suggestions.length === 0 && connections.length === 0 ? (
        <p className="text-sm text-muted-foreground">{translateInterface("mbc3c7686445c", { app: appName })}</p>
      ) : (
        <ul className={groupClass}>
          {suggestions.map((s) => {
            const { from, to } = suggestionNames(s, nameOf);
            const installed = s.targetInstalled !== false;
            const mine = busy?.id === s.id;
            return (
              <li key={s.id} className={rowClass}>
                <div className="min-w-0">
                  <p id={titleId(s.id)} className="text-sm font-medium text-foreground [overflow-wrap:anywhere]">{translateInterface("m7b0526da26e5", { from, to })}</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
                    {installed ? translateInterface("m8c8eb54074f4", { from }) : translateInterface("me1d37689abed", { to })}
                    {s.scope === "user" ? ` ${translateInterface("m6f90797e1749")}` : s.scope === "service" ? ` ${translateInterface("m287ff2d5346e")}` : ""}
                  </p>
                  {errorFor(s.id)}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {installed && (
                    <Button size="sm" onClick={() => void approve(s)} disabled={busy !== null} aria-describedby={titleId(s.id)} aria-busy={mine && busy?.action === "approve"}>
                      {mine && busy?.action === "approve" && spinner}{translateInterface("m6007acbe30b2")}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => void dismiss(s)} disabled={busy !== null} aria-describedby={titleId(s.id)} aria-busy={mine && busy?.action === "dismiss"}>
                    {mine && busy?.action === "dismiss" && spinner}{translateInterface("m48845bff334a")}
                  </Button>
                </div>
              </li>
            );
          })}
          {connections.map((c) => {
            const mine = busy?.id === c.id;
            const state = c.rewirePending ? translateInterface("ma812e71f3ba9")
              : !c.active ? translateInterface("m5e27a7a74502", { to: label(c.to) })
              : c.direction === "both-ways" ? translateInterface("m843f1d33ff4b") : translateInterface("me38352f64711");
            return (
              <li key={c.id} className={rowClass}>
                <div className="min-w-0">
                  <p id={titleId(c.id)} className="text-sm font-medium text-foreground [overflow-wrap:anywhere]">{translateInterface("m7b02fe45a8ef", { from: label(c.from), to: label(c.to) })}</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{state}</p>
                  {errorFor(c.id)}
                </div>
                <Button size="sm" variant="outline" className="shrink-0 self-start sm:self-center" onClick={() => setConfirm(c)} disabled={busy !== null} aria-describedby={titleId(c.id)} aria-busy={mine}>
                  {mine && spinner}{translateInterface("macfc5be785a9")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </AppSection>
  );
}
