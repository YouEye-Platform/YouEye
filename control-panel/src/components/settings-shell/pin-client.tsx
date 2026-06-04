"use client";

import { useEffect, useState } from "react";
import { uiSettingsApi } from "./api-base";

export function PinClient() {
  const [hasPin, setHasPin] = useState(false);
  const [sessionActive, setSessionActive] = useState(false);
  const [pin, setPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [status, setStatus] = useState("");

  async function load() {
    const res = await fetch(uiSettingsApi("pin/status"));
    if (!res.ok) return;
    const data = await res.json();
    setHasPin(data.has_pin);
    setSessionActive(data.session_active);
  }

  useEffect(() => { load(); }, []);

  async function create() {
    const res = await fetch(uiSettingsApi("pin/create"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    setStatus(res.ok ? "PIN created" : "Could not create PIN");
    setPin("");
    load();
  }

  async function change() {
    const res = await fetch(uiSettingsApi("pin/change"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_pin: pin, new_pin: newPin }),
    });
    setStatus(res.ok ? "PIN changed" : "Could not change PIN");
    setPin("");
    setNewPin("");
    load();
  }

  async function endSession() {
    await fetch(uiSettingsApi("pin/session"), { method: "DELETE" });
    setStatus("PIN session ended");
    load();
  }

  return (
    <div className="max-w-lg space-y-4 rounded-lg border bg-card p-4">
      <div>
        <h2 className="text-base font-medium">{hasPin ? "Encryption PIN is active" : "No encryption PIN"}</h2>
        <p className="text-sm text-muted-foreground">PIN sessions protect encrypted timeline data.</p>
      </div>
      <input
        type="password"
        value={pin}
        onChange={(event) => setPin(event.target.value)}
        placeholder={hasPin ? "Current PIN" : "New PIN"}
        className="w-full rounded-md border bg-background px-3 py-2"
      />
      {hasPin && (
        <input
          type="password"
          value={newPin}
          onChange={(event) => setNewPin(event.target.value)}
          placeholder="New PIN"
          className="w-full rounded-md border bg-background px-3 py-2"
        />
      )}
      <div className="flex gap-2">
        <button onClick={hasPin ? change : create} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground">
          {hasPin ? "Change PIN" : "Create PIN"}
        </button>
        {sessionActive && (
          <button onClick={endSession} className="rounded-md border px-3 py-2 text-sm">
            End Session
          </button>
        )}
      </div>
      {status && <p className="text-sm text-muted-foreground">{status}</p>}
    </div>
  );
}
