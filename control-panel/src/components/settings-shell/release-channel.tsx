"use client";

import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OFFICIAL_RELEASE_REPOSITORY, isSameRepository, repositoryAddress } from "@/lib/releases/release-source";

const CHANNELS = ["dev", "alpha", "beta", "stable"] as const;
type ReleaseChannel = { repository: string; channel: string; installed_version?: string; head_version?: string };

/**
 * The box's release channel and repository (host-owned; admins only). A channel change is saved at once; a
 * repository change is confirmed first, and Spine reads the new repository's channel index before it switches.
 */
export function ReleaseChannelSetting() {
  const translateInterface = useInterfaceTranslations("interface");
  const t = useInterfaceTranslations("settingsSystem");
  const panelId = useId();
  const repositoryId = useId();
  // Switching is rare: the line shows the channel, "Change…" reveals the controls.
  const [open, setOpen] = useState(false);
  const channelName = (channel: string) => (CHANNELS as readonly string[]).includes(channel) ? t(`channel.names.${channel}`) : channel;
  const [current, setCurrent] = useState<ReleaseChannel | null>(null);
  const [selected, setSelected] = useState("");
  const [repository, setRepository] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/settings/api/releases/channel", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const body = await response.json();
      if (!response.ok || typeof body.channel !== "string") throw new Error("unavailable");
      setCurrent(body); setSelected(body.channel); setRepository(body.repository);
    }).catch(() => { if (!controller.signal.aborted) setError(translateInterface("m66de5771dc12")); });
    return () => controller.abort();
  }, [translateInterface]);

  const address = repositoryAddress(repository);
  const repositoryChanges = current !== null && !isSameRepository(repository, current.repository);
  const unchanged = current !== null && !repositoryChanges && selected === current.channel;

  function reset(next: ReleaseChannel) {
    setSelected(next.channel); setRepository(next.repository); setConfirming(false);
  }

  async function save() {
    if (!current || (repositoryChanges && !address)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const csrf = await fetch("/settings/api/auth/csrf", { cache: "no-store" }).then((r) => r.json());
      const response = await fetch("/settings/api/releases/channel", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": String(csrf.csrfToken ?? "") },
        body: JSON.stringify(repositoryChanges ? { channel: selected, repository: address } : { channel: selected }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.channel !== "string") {
        // Spine says why it refused a repository (unreachable, not a YouEye repository, …).
        setError(repositoryChanges && typeof body.error === "string" ? t("channel.refused", { reason: body.error }) : translateInterface("m84d6732746f8"));
        return;
      }
      setCurrent(body); reset(body);
      setNotice(typeof body.head_version === "string"
        ? t("channel.switchedSource", { channel: channelName(body.channel), repository: body.repository, version: body.head_version })
        : t("channel.switched", { channel: channelName(body.channel) }));
      setOpen(false);
    } catch {
      setError(translateInterface("m84d6732746f8"));
    } finally {
      setBusy(false);
    }
  }

  return <div className="border-t pt-3">
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <p className="min-w-0 text-sm">{current ? t("channel.line", { channel: channelName(current.channel) }) : translateInterface("md89ba8a2a6fc")}</p>
      {current && <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={panelId} disabled={busy} onClick={() => { setOpen(!open); reset(current); setError(""); }}>
        {open ? translateInterface("m19766ed6ccb2") : t("channel.change")}
      </Button>}
    </div>
    {!open && current && <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{t("channel.repositoryLine", { repository: current.repository })}</p>}
    {open && current && <div id={panelId} className="mt-2 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={selected} onValueChange={(value) => { setSelected(value); setConfirming(false); }} disabled={busy}>
          <SelectTrigger className="h-9 w-40" aria-label={translateInterface("md89ba8a2a6fc")}><SelectValue /></SelectTrigger>
          <SelectContent>{CHANNELS.map((channel) => <SelectItem key={channel} value={channel}>{channelName(channel)}</SelectItem>)}</SelectContent>
        </Select>
        {!repositoryChanges && <Button variant="outline" size="sm" disabled={busy || unchanged} onClick={() => void save()}>
          {busy && <Loader2 className="size-4 animate-spin" />} {translateInterface("m716970972267")}
        </Button>}
      </div>
      <div className="space-y-1.5">
        <label htmlFor={repositoryId} className="text-sm font-medium">{t("channel.repository")}</label>
        <Input id={repositoryId} className="font-mono text-xs" inputMode="url" autoComplete="off" spellCheck={false} disabled={busy}
          value={repository} onChange={(event) => { setRepository(event.target.value); setConfirming(false); }} />
        <p className="max-w-prose text-xs text-muted-foreground">{t("channel.repositoryHint")}</p>
        {repositoryChanges && !address && <p className="text-xs text-destructive">{t("channel.invalidRepository")}</p>}
        {repositoryAddress(repository) !== OFFICIAL_RELEASE_REPOSITORY && <Button variant="link" size="sm" className="h-auto px-0" disabled={busy}
          onClick={() => { setRepository(OFFICIAL_RELEASE_REPOSITORY); setConfirming(false); }}>{t("channel.useOfficial")}</Button>}
      </div>
      {repositoryChanges && address && !confirming && <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirming(true)}>{t("channel.switchSource")}</Button>}
      {repositoryChanges && address && confirming && <div className="space-y-2 rounded-md border p-3" role="alertdialog" aria-label={t("channel.switchSource")}>
        <p className="max-w-prose text-sm">{t("channel.confirm", { channel: channelName(selected), repository: address })}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void save()}>{busy && <Loader2 className="size-4 animate-spin" />} {t("channel.switchSource")}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>{translateInterface("m19766ed6ccb2")}</Button>
        </div>
      </div>}
      {!repositoryChanges && <p className="max-w-prose text-xs text-muted-foreground">{translateInterface("mb2585dff0f5d")}</p>}
    </div>}
    {notice && <p className="mt-2 text-sm text-muted-foreground" role="status">{notice}</p>}
    {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
  </div>;
}
