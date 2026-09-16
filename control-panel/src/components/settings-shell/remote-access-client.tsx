"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/settings-shell/page-header";
import type { SpineRemoteAccessKey, SpineRemoteAccessKeysResponse } from "@/lib/spine/client";

function friendlyType(key: SpineRemoteAccessKey) {
  if (key.type === "ssh-ed25519") return "Ed25519";
  if (key.type.startsWith("sk-ssh-ed25519")) return "Security key (Ed25519)";
  if (key.type.startsWith("sk-ecdsa")) return "Security key (ECDSA)";
  if (key.type === "ssh-rsa") return `RSA ${key.bits ?? ""}`.trim();
  if (key.type.startsWith("ecdsa-")) return "ECDSA";
  return key.type;
}

async function csrfToken() {
  const response = await fetch("/settings/api/auth/csrf", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.csrfToken !== "string") throw new Error("Could not start a protected settings action.");
  return body.csrfToken as string;
}

export function RemoteAccessClient() {
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
      if (!response.ok) throw new Error(body.error || "SSH settings are unavailable.");
      setData(body as SpineRemoteAccessKeysResponse);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "SSH settings are unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);

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
      if (!response.ok) throw new Error(body.error || "The SSH key could not be added.");
      setPublicKey("");
      setMessage("SSH key added.");
      await load();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "The SSH key could not be added.");
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
      if (!response.ok) throw new Error(body.error || "The SSH key could not be deleted.");
      setDeleteKey(null);
      setMessage(finalKey ? "The final SSH key was deleted. New root SSH sessions are disabled." : "SSH key deleted.");
      await load();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "The SSH key could not be deleted.");
    } finally {
      setBusy(false);
    }
  }

  const keys = data?.keys ?? [];
  const deletingFinalKey = keys.length === 1 && deleteKey?.id === keys[0]?.id;

  return (
    <div>
      <PageHeader title="SSH" description="Root SSH access for appliance administration." />

      <section className="border-b pb-6">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 text-primary" />
          <div>
            <h2 className="text-[15px] font-semibold">Public keys only</h2>
            <p className="mt-1 text-sm text-muted-foreground">The root password is locked. Existing SSH sessions stay connected when a key is removed.</p>
          </div>
        </div>
      </section>

      <section className="border-b py-6">
        <h2 className="text-[15px] font-semibold">Add a key</h2>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input
            value={publicKey}
            onChange={(event) => setPublicKey(event.target.value)}
            placeholder="ssh-ed25519 AAAA... name@computer"
            aria-label="SSH public key"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          <Button onClick={() => void addKey()} disabled={busy || !publicKey.trim()} className="shrink-0">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Add key
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Ed25519 is recommended. Hardware-backed Ed25519 or ECDSA and RSA 3072-bit or stronger are also accepted.</p>
      </section>

      <section className="py-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[15px] font-semibold">Authorised keys</h2>
          <Button variant="ghost" size="icon" onClick={() => void load()} disabled={loading} title="Refresh keys">
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
            <span className="sr-only">Refresh keys</span>
          </Button>
        </div>

        {error && <Alert variant="destructive" className="mt-4"><AlertDescription>{error}</AlertDescription></Alert>}
        {message && <Alert className="mt-4"><AlertDescription>{message}</AlertDescription></Alert>}

        {loading && !data ? (
          <div className="mt-5 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading keys</div>
        ) : keys.length === 0 ? (
          <div className="mt-5 flex items-center gap-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            <KeyRound className="size-4" />New root SSH sessions are disabled.
          </div>
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
                <Button variant="ghost" size="icon" onClick={() => setDeleteKey(key)} disabled={busy} title="Delete key">
                  <Trash2 className="size-4" />
                  <span className="sr-only">Delete {key.comment || key.fingerprint}</span>
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={deleteKey !== null}
        title={deletingFinalKey ? "Disable new root SSH access?" : "Delete this SSH key?"}
        description={deletingFinalKey
          ? "This is the final authorised key. Current sessions remain connected, but no new root SSH session can start until another key is added from Settings or Recovery."
          : `New SSH sessions using ${deleteKey?.comment || deleteKey?.fingerprint || "this key"} will be denied.`}
        confirmLabel={deletingFinalKey ? "Delete final key" : "Delete key"}
        confirmDisabled={busy}
        destructive
        onConfirm={() => void removeKey()}
        onCancel={() => { if (!busy) setDeleteKey(null); }}
      />
    </div>
  );
}
