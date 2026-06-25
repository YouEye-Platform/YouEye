"use client";

import { useState } from "react";

interface PermissionApprovalFormProps {
  appId: string;
  permissions: string[];
  grantType: string;
  returnTo?: string;
}

export function PermissionApprovalForm({ appId, permissions, grantType, returnTo }: PermissionApprovalFormProps) {
  const [status, setStatus] = useState<"idle" | "approving" | "approved" | "denied" | "error">("idle");

  function finish() {
    if (returnTo) window.location.assign(returnTo);
  }

  async function approve() {
    setStatus("approving");
    const res = await fetch("/api/v1/permissions/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: appId,
        permissions,
        grant_type: grantType,
        approved: true,
        return_to: returnTo,
      }),
    });
    if (!res.ok) {
      setStatus("error");
      return;
    }
    setStatus("approved");
    finish();
  }

  return (
    <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
      {status === "approved" && (
        <p className="mr-auto text-sm text-emerald-600">Permission granted.</p>
      )}
      {status === "denied" && (
        <p className="mr-auto text-sm text-muted-foreground">Permission denied.</p>
      )}
      {status === "error" && (
        <p className="mr-auto text-sm text-destructive">Could not update this permission.</p>
      )}
      <button
        type="button"
        className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent"
        onClick={() => {
          setStatus("denied");
          finish();
        }}
        disabled={status === "approving" || status === "approved"}
      >
        Deny
      </button>
      <button
        type="button"
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        onClick={approve}
        disabled={status === "approving" || status === "approved"}
      >
        {status === "approving" ? "Allowing..." : "Allow"}
      </button>
    </div>
  );
}
