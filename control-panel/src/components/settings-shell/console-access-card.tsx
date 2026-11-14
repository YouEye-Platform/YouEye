"use client";

import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ChevronDown, ChevronRight, Loader2, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

interface ConsoleAccessView {
  accounts: Array<{ userId: string; hostUsername: string; name: string; canSignIn: boolean; you: boolean }>;
  rootPasswordSet: boolean;
  passwordSSH: boolean;
  sshScope: string | null;
}

const API = "/settings/api/appliance/console-access";

async function csrfToken(): Promise<string> {
  const body = await fetch("/settings/api/auth/csrf").then((response) => response.json());
  return body.csrfToken as string;
}

async function send(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": await csrfToken() },
    body: JSON.stringify(body),
  });
}

/** Spine's rule for console passwords: 8 to 1024 characters on one line. */
function validConsolePassword(password: string): boolean {
  return password.length >= 8 && password.length <= 1024 && !/[\0\r\n]/.test(password);
}

export function ConsoleAccessCard() {
  const translateInterface = useInterfaceTranslations("interface");
  const [view, setView] = useState<ConsoleAccessView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [password, setPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [rootPassword, setRootPassword] = useState("");
  const [advanced, setAdvanced] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const response = await fetch(API, { cache: "no-store" });
    if (response.ok) setView(await response.json());
    else setError((await response.json().catch(() => ({}))).error || translateInterface("m71bfa19d168b"));
    setLoading(false);
  }, [translateInterface]);

  useEffect(() => { load(); }, [load]);

  async function run(action: string, work: () => Promise<Response>, done: string, after?: () => void) {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const response = await work();
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error || translateInterface("m3855ba07893c"));
        return;
      }
      if (body.accounts) setView(body);
      else await load();
      after?.();
      setNotice(done);
    } catch {
      setError(translateInterface("m3855ba07893c"));
    } finally {
      setBusy("");
    }
  }

  function setOwnPassword(event: FormEvent) {
    event.preventDefault();
    if (!validConsolePassword(password)) return setError(translateInterface("m4b3fa604d8fc"));
    if (password !== repeatPassword) return setError(translateInterface("mb6eb82cd3300"));
    void run("password", () => send(`${API}/password`, { password, repeatPassword }), translateInterface("m3da1f529fa4b"), () => {
      setPassword("");
      setRepeatPassword("");
    });
  }

  function setRoot(event: FormEvent) {
    event.preventDefault();
    if (!validConsolePassword(rootPassword)) return setError(translateInterface("m4b3fa604d8fc"));
    void run("root", () => send(API, { rootPassword }), translateInterface("m5932f60ebef2"), () => setRootPassword(""));
  }

  const youAreListed = Boolean(view?.accounts.some((account) => account.you));

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start justify-between gap-4 border-b p-4">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold"><Monitor className="size-4" />{translateInterface("mcb5c7e85cbe1")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{translateInterface("m066597c0a716")}</p>
        </div>
        {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>

      <div className="divide-y px-4">
        {view && view.accounts.length === 0 && <p className="py-3 text-sm text-muted-foreground">{translateInterface("ma2f9c9d61339")}</p>}
        {view?.accounts.map((account) => (
          <div key={account.userId} className="flex items-center justify-between gap-4 py-2">
            <div>
              <p className="text-sm font-medium">{account.name}{account.you && <span className="ml-2 text-xs text-muted-foreground">{translateInterface("md1eb47c77576")}</span>}</p>
              <p className="text-xs text-muted-foreground">{translateInterface("maa16cb16895e", { username: account.hostUsername })}</p>
            </div>
            <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
              <span className={`size-2 rounded-full ${account.canSignIn ? "bg-green-500" : "bg-amber-500"}`} />
              {account.canSignIn ? translateInterface("m7885d37aa9e1") : translateInterface("m11f1e05e9f2f")}
            </span>
          </div>
        ))}
      </div>

      {youAreListed && (
        <form onSubmit={setOwnPassword} className="space-y-3 border-t p-4">
          <div>
            <p className="text-sm font-medium">{translateInterface("mc09405578854")}</p>
            <p className="text-xs text-muted-foreground">{translateInterface("m243d56ec4ba7")}</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} aria-label={translateInterface("m3dd9df4441fb")} placeholder={translateInterface("m3dd9df4441fb")} />
            <Input type="password" autoComplete="new-password" value={repeatPassword} onChange={(event) => setRepeatPassword(event.target.value)} aria-label={translateInterface("mb74070f90e8c")} placeholder={translateInterface("mb74070f90e8c")} />
          </div>
          <Button type="submit" size="sm" disabled={Boolean(busy) || !password}>
            {busy === "password" && <Loader2 className="size-4 animate-spin" />}{translateInterface("m7058e603522a")}</Button>
        </form>
      )}

      <div className="border-t p-4">
        <button type="button" className="flex items-center gap-1 text-sm font-medium" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
          {advanced ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}{translateInterface("m9f088dbebd6c")}</button>
        {advanced && view && (
          <div className="mt-3 space-y-4">
            <form onSubmit={setRoot} className="space-y-2">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">{translateInterface("m756e295ae505")}</p>
                  <p className="text-xs text-muted-foreground">{translateInterface("m809f3dde17a8")}</p>
                </div>
                <span className="shrink-0 text-sm text-muted-foreground">{view.rootPasswordSet ? translateInterface("mb6f6f3ad07b3") : translateInterface("m4895f73177ab")}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Input className="max-w-xs" type="password" autoComplete="new-password" value={rootPassword} onChange={(event) => setRootPassword(event.target.value)} aria-label={translateInterface("m99e8d76a5c3a")} placeholder={translateInterface("m99e8d76a5c3a")} />
                <Button type="submit" size="sm" variant="outline" disabled={Boolean(busy) || !rootPassword}>
                  {busy === "root" && <Loader2 className="size-4 animate-spin" />}{translateInterface("m8cd8c220870b")}</Button>
                {view.rootPasswordSet && (
                  <Button type="button" size="sm" variant="outline" disabled={Boolean(busy)}
                    onClick={() => void run("remove-root", () => send(API, { rootPassword: "" }), translateInterface("md881ae5af632"))}>
                    {busy === "remove-root" && <Loader2 className="size-4 animate-spin" />}{translateInterface("mfb51480e2d14")}</Button>
                )}
              </div>
            </form>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium">{translateInterface("ma732acf5d120")}</p>
                <p className="text-xs text-muted-foreground">
                  {!view.passwordSSH ? translateInterface("m5f88f8c2492d")
                    : view.sshScope ? translateInterface("m327cbeea36e0", { scope: view.sshScope })
                    : translateInterface("mc93ef2549161")}
                </p>
              </div>
              <Switch checked={view.passwordSSH} disabled={Boolean(busy)} aria-label={translateInterface("ma732acf5d120")}
                onCheckedChange={(on) => void run("ssh", () => send(API, { passwordSSH: on }), translateInterface("mb5c120b316c2"))} />
            </div>
          </div>
        )}
      </div>

      {(error || notice) && (
        <div className="border-t p-4">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
        </div>
      )}
    </Card>
  );
}
