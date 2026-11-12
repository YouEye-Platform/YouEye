"use client";

import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const CHANNELS = ["dev", "alpha", "beta", "stable"] as const;
type ReleaseChannel = { repository: string; channel: string; installed_version?: string };

/** The box's release channel (host-owned). Switching stays within the same repository. */
export function ReleaseChannelSetting() {
  const translateInterface = useInterfaceTranslations("interface");
  const [current, setCurrent] = useState<ReleaseChannel | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/settings/api/releases/channel", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const body = await response.json();
      if (!response.ok || typeof body.channel !== "string") throw new Error("unavailable");
      setCurrent(body); setSelected(body.channel);
    }).catch(() => { if (!controller.signal.aborted) setError(translateInterface("m66de5771dc12")); });
    return () => controller.abort();
  }, [translateInterface]);

  async function save() {
    setBusy(true); setError(""); setNotice("");
    try {
      const csrf = await fetch("/settings/api/auth/csrf", { cache: "no-store" }).then((r) => r.json());
      const response = await fetch("/settings/api/releases/channel", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": String(csrf.csrfToken ?? "") },
        body: JSON.stringify({ channel: selected }),
      });
      const body = await response.json();
      if (!response.ok || typeof body.channel !== "string") throw new Error("failed");
      setCurrent(body); setSelected(body.channel);
      setNotice(translateInterface("m970dd0475e19", { channel: body.channel }));
    } catch {
      setError(translateInterface("m84d6732746f8"));
    } finally {
      setBusy(false);
    }
  }

  return <div className="space-y-2">
    <h4 className="text-sm font-medium">{translateInterface("md89ba8a2a6fc")}</h4>
    {current && <p className="break-all font-mono text-xs text-muted-foreground">{translateInterface("m627ce14f7b75", { repository: current.repository })}</p>}
    {current && <div className="flex flex-wrap items-center gap-2">
      <Select value={selected} onValueChange={setSelected} disabled={busy}>
        <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
        <SelectContent>{CHANNELS.map((channel) => <SelectItem key={channel} value={channel}>{channel}</SelectItem>)}</SelectContent>
      </Select>
      <Button variant="outline" size="sm" disabled={busy || selected === current.channel} onClick={() => void save()}>
        {busy && <Loader2 className="size-4 animate-spin" />} {translateInterface("m716970972267")}
      </Button>
    </div>}
    <p className="text-xs text-muted-foreground">{translateInterface("mb2585dff0f5d")}</p>
    {notice && <p className="text-sm text-muted-foreground" role="status">{notice}</p>}
    {error && <p className="text-sm text-destructive">{error}</p>}
  </div>;
}
