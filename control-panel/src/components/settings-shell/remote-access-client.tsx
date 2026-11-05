"use client";




import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/settings-shell/page-header";
import type { SpineRemoteAccessKey, SpineRemoteAccessKeysResponse } from "@/lib/spine/client";





export function RemoteAccessClient() {
  const translateInterface = useInterfaceTranslations("interface");
function friendlyType(key: SpineRemoteAccessKey) {
  if (key.type === "ssh-ed25519") return "Ed25519";
  if (key.type.startsWith("sk-ssh-ed25519")) return translateInterface("mac798a639cfa");
  if (key.type.startsWith("sk-ecdsa")) return translateInterface("mdde020273d5f");
  if (key.type === "ssh-rsa") return `RSA ${key.bits ?? ""}`.trim();
  if (key.type.startsWith("ecdsa-")) return "ECDSA";
  return key.type;
}

async function csrfToken() {
  const response = await fetch("/settings/api/auth/csrf", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.csrfToken !== "string") throw new Error(translateInterface("m8467ce88cef6"));
  return body.csrfToken as string;
}


  const [data, setData] = useState<SpineRemoteAccessKeysResponse | null>(null);
  const [publicKey, setPublicKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [deleteKey, setDeleteKey] = useState<SpineRemoteAccessKey | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/settings/api/appliance/remote-access/keys", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || translateInterface("m54a1c1f44de0"));
      setData(body as SpineRemoteAccessKeysResponse);
    } catch (loadError) {
      setError(translateInterface("m54a1c1f44de0"));
    } finally {
      setLoading(false);
    }
  }, [translateInterface]);

  useEffect(() => { void load(); }, [load]);

  async function addKey() {
    if (!publicKey.trim()) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const csrf = await csrfToken();
      const response = await fetch("/settings/api/appliance/remote-access/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ public_key: publicKey.trim() }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || translateInterface("m24330987199f"));
      setPublicKey("");
      setMessage(translateInterface("mf9ca5e9225e4"));
      await load();
    } catch (addError) {
      setError(translateInterface("m24330987199f"));
    } finally {
      setBusy(false);
    }
  }

  async function removeKey() {
    if (!deleteKey) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const csrf = await csrfToken();
      const finalKey = (data?.keys.length ?? 0) === 1;
      const response = await fetch(`/settings/api/appliance/remote-access/keys/${deleteKey.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ confirm_last_key: finalKey }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || translateInterface("me9cd7a777f35"));
      setDeleteKey(null);
      setMessage(finalKey ? translateInterface("m65efca0655b9") : translateInterface("m108848a5e566"));
      await load();
    } catch (deleteError) {
      setError(translateInterface("me9cd7a777f35"));
    } finally {
      setBusy(false);
    }
  }

  const keys = data?.keys ?? [];
  const deletingFinalKey = keys.length === 1 && deleteKey?.id === keys[0]?.id;

  return (
    <div>
      <PageHeader title="SSH" description={translateInterface("m6e0eb9894352")} />

      <section className="border-b pb-6">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 text-primary" />
          <div>
            <h2 className="text-[15px] font-semibold">{translateInterface("m5fd65928ccc2")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{translateInterface("m68f3f9d4e3a0")}</p>
          </div>
        </div>
      </section>

      <section className="border-b py-6">
        <h2 className="text-[15px] font-semibold">{translateInterface("m2feab16f91f2")}</h2>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input
            value={publicKey}
            onChange={(event) => setPublicKey(event.target.value)}
            placeholder="ssh-ed25519 AAAA... name@computer"
            aria-label={translateInterface("mc9be6a369e1a")}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          <Button onClick={() => void addKey()} disabled={busy || !publicKey.trim()} className="shrink-0">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {translateInterface("m12626d65b219")}</Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{translateInterface("mfd03a1cb79c5")}</p>
      </section>

      <section className="py-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[15px] font-semibold">{translateInterface("mc553364703dc")}</h2>
          <Button variant="ghost" size="icon" onClick={() => void load()} disabled={loading} title={translateInterface("mcf0f17fe58d9")}>
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
            <span className="sr-only">{translateInterface("mcf0f17fe58d9")}</span>
          </Button>
        </div>

        {error && <Alert variant="destructive" className="mt-4"><AlertDescription>{error}</AlertDescription></Alert>}
        {message && <Alert className="mt-4"><AlertDescription>{message}</AlertDescription></Alert>}

        {loading && !data ? (
          <div className="mt-5 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{translateInterface("m54e6709b3335")}</div>
        ) : keys.length === 0 ? (
          <div className="mt-5 flex items-center gap-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            <KeyRound className="size-4" />{translateInterface("m10df51da2d9b")}</div>
        ) : (
          <div className="mt-4 divide-y rounded-md border">
            {keys.map((key) => (
              <div key={key.id} className="flex min-w-0 items-center gap-3 p-4">
                <KeyRound className="size-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{key.comment || friendlyType(key)}</div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
                    <span>{friendlyType(key)}</span>
                    <span className="break-all">{key.fingerprint}</span>
                  </div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setDeleteKey(key)} disabled={busy} title={translateInterface("m6758f1d9b9b4")}>
                  <Trash2 className="size-4" />
                  <span className="sr-only">{translateInterface("me2d0a54968ea")}{" "}{key.comment || key.fingerprint}</span>
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={deleteKey !== null}
        title={deletingFinalKey ? translateInterface("md9bbe1782312") : translateInterface("m0df8fdc3064a")}
        description={deletingFinalKey
          ? translateInterface("m9783fc11fa03")
          : translateInterface("mebe7d794e58a", { value0: String(deleteKey?.comment || deleteKey?.fingerprint || translateInterface("mc9e64db2715f")) })}
        confirmLabel={deletingFinalKey ? translateInterface("mf016bbf3772b") : translateInterface("m6758f1d9b9b4")}
        confirmDisabled={busy}
        destructive
        onConfirm={() => void removeKey()}
        onCancel={() => { if (!busy) setDeleteKey(null); }}
      />
    </div>
  );
}
