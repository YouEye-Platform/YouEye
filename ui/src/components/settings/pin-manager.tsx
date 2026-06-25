/**
 * Privacy Settings — PIN Management
 *
 * Client component for managing encryption PIN:
 * - Create PIN (if not set)
 * - Change PIN
 * - View session status
 */

"use client";

import { useState, useEffect } from "react";
import { Shield, Lock, Unlock, KeyRound, RefreshCw, Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";

export function PINManager() {
  const [pinExists, setPinExists] = useState(false);
  const [sessionActive, setSessionActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const t = useTranslations('pinManager');

  // Change PIN form
  const [showChangeForm, setShowChangeForm] = useState(false);
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmNewPin, setConfirmNewPin] = useState("");
  const [showPins, setShowPins] = useState(false);
  const [changeError, setChangeError] = useState("");
  const [changeSuccess, setChangeSuccess] = useState(false);
  const [changing, setChanging] = useState(false);

  // Create PIN form
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createPin, setCreatePin] = useState("");
  const [confirmCreatePin, setConfirmCreatePin] = useState("");
  const [createError, setCreateError] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchStatus();
  }, []);

  const fetchStatus = async () => {
    try {
      const res = await fetch("/api/v1/pin/status");
      if (res.ok) {
        const data = await res.json();
        setPinExists(data.has_pin);
        setSessionActive(data.session_active);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const handleCreatePIN = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError("");

    if (createPin.length < 4) {
      setCreateError(t('pinMinLength'));
      return;
    }
    if (createPin !== confirmCreatePin) {
      setCreateError(t('pinMismatch'));
      return;
    }

    setCreating(true);
    try {
      const res = await fetch("/api/v1/pin/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: createPin }),
      });

      if (!res.ok) {
        const data = await res.json();
        setCreateError(data.error);
        return;
      }

      setPinExists(true);
      setSessionActive(true);
      setShowCreateForm(false);
      setCreatePin("");
      setConfirmCreatePin("");
    } catch {
      setCreateError(t('pinMinLength'));
    } finally {
      setCreating(false);
    }
  };

  const handleChangePIN = async (e: React.FormEvent) => {
    e.preventDefault();
    setChangeError("");
    setChangeSuccess(false);

    if (newPin.length < 4) {
      setChangeError(t('newPinMinLength'));
      return;
    }
    if (newPin !== confirmNewPin) {
      setChangeError(t('newPinMismatch'));
      return;
    }

    setChanging(true);
    try {
      const res = await fetch("/api/v1/pin/change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_pin: currentPin,
          new_pin: newPin,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setChangeError(data.error);
        return;
      }

      setChangeSuccess(true);
      setCurrentPin("");
      setNewPin("");
      setConfirmNewPin("");
      setSessionActive(false);
      setTimeout(() => {
        setShowChangeForm(false);
        setChangeSuccess(false);
      }, 2000);
    } catch {
      setChangeError(t('newPinMinLength'));
    } finally {
      setChanging(false);
    }
  };

  const handleLock = async () => {
    await fetch("/api/v1/pin/session", { method: "DELETE" });
    setSessionActive(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* PIN Status */}
      <div className="flex items-center justify-between p-4 bg-card border rounded-lg">
        <div className="flex items-center gap-3">
          <div
            className={`w-10 h-10 rounded-full flex items-center justify-center ${
              pinExists
                ? "bg-green-500/10 text-green-500"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {pinExists ? (
              <Shield className="w-5 h-5" />
            ) : (
              <Lock className="w-5 h-5" />
            )}
          </div>
          <div>
            <p className="font-medium text-sm">
              {pinExists ? t('encryptionActive') : t('noPin')}
            </p>
            <p className="text-xs text-muted-foreground">
              {pinExists
                ? sessionActive
                  ? t('sessionActive')
                  : t('timelineLocked')
                : t('setupPrompt')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {pinExists && sessionActive && (
            <button
              onClick={handleLock}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border hover:bg-accent transition-colors"
            >
              <Lock className="w-3.5 h-3.5" />
            </button>
          )}
          {pinExists && (
            <button
              onClick={() => setShowChangeForm(!showChangeForm)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border hover:bg-accent transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              {t('changePin')}
            </button>
          )}
          {!pinExists && (
            <button
              onClick={() => setShowCreateForm(!showCreateForm)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors"
            >
              <KeyRound className="w-3.5 h-3.5" />
              {t('createPin')}
            </button>
          )}
        </div>
      </div>

      {/* Create PIN form */}
      {showCreateForm && !pinExists && (
        <form
          onSubmit={handleCreatePIN}
          className="p-4 bg-card border rounded-lg space-y-4"
        >
          <h3 className="font-medium text-sm">{t('createTitle')}</h3>
          <div className="grid gap-3 max-w-sm">
            <div>
              <label className="block text-xs font-medium mb-1">{t('pinLabel')}</label>
              <input
                type={showPins ? "text" : "password"}
                value={createPin}
                onChange={(e) => setCreatePin(e.target.value)}
                placeholder={t('pinPlaceholder')}
                className="w-full px-3 py-2 text-sm bg-muted rounded-lg border-0 focus:outline-none focus:ring-2 focus:ring-ring"
                autoComplete="off"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                {t('confirmPin')}
              </label>
              <input
                type={showPins ? "text" : "password"}
                value={confirmCreatePin}
                onChange={(e) => setConfirmCreatePin(e.target.value)}
                placeholder={t('confirmPlaceholder')}
                className="w-full px-3 py-2 text-sm bg-muted rounded-lg border-0 focus:outline-none focus:ring-2 focus:ring-ring"
                autoComplete="off"
              />
            </div>
          </div>

          {createError && (
            <p className="text-sm text-red-500">{createError}</p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {creating ? t('creating') : t('createPin')}
            </button>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={showPins}
                onChange={(e) => setShowPins(e.target.checked)}
                className="rounded"
              />
              {t('showPins')}
            </label>
          </div>

          <p className="text-xs text-muted-foreground">
            {t('pinWarning')}
          </p>
        </form>
      )}

      {/* Change PIN form */}
      {showChangeForm && pinExists && (
        <form
          onSubmit={handleChangePIN}
          className="p-4 bg-card border rounded-lg space-y-4"
        >
          <h3 className="font-medium text-sm">{t('changeTitle')}</h3>
          <p className="text-xs text-muted-foreground">
            {t('changeDescription')}
          </p>
          <div className="grid gap-3 max-w-sm">
            <div>
              <label className="block text-xs font-medium mb-1">
                {t('currentPin')}
              </label>
              <input
                type={showPins ? "text" : "password"}
                value={currentPin}
                onChange={(e) => setCurrentPin(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-muted rounded-lg border-0 focus:outline-none focus:ring-2 focus:ring-ring"
                autoComplete="off"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">{t('newPin')}</label>
              <input
                type={showPins ? "text" : "password"}
                value={newPin}
                onChange={(e) => setNewPin(e.target.value)}
                placeholder={t('pinPlaceholder')}
                className="w-full px-3 py-2 text-sm bg-muted rounded-lg border-0 focus:outline-none focus:ring-2 focus:ring-ring"
                autoComplete="off"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                {t('confirmNewPin')}
              </label>
              <input
                type={showPins ? "text" : "password"}
                value={confirmNewPin}
                onChange={(e) => setConfirmNewPin(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-muted rounded-lg border-0 focus:outline-none focus:ring-2 focus:ring-ring"
                autoComplete="off"
              />
            </div>
          </div>

          {changeError && (
            <p className="text-sm text-red-500">{changeError}</p>
          )}
          {changeSuccess && (
            <p className="text-sm text-green-500">
              {t('changeSuccess')}
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={changing}
              className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {changing ? t('reencrypting') : t('changePin')}
            </button>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={showPins}
                onChange={(e) => setShowPins(e.target.checked)}
                className="rounded"
              />
              {t('showPins')}
            </label>
          </div>
        </form>
      )}

      {/* Info */}
      <div className="p-4 bg-muted/50 rounded-lg">
        <h3 className="font-medium text-sm mb-2">{t('aboutTitle')}</h3>
        <ul className="text-xs text-muted-foreground space-y-1.5">
          <li>
            &bull; {t('aboutAes')}
          </li>
          <li>&bull; {t('aboutPbkdf2')}</li>
          <li>&bull; {t('aboutNeverStored')}</li>
          <li>&bull; {t('aboutSession')}</li>
          <li>
            &bull; {t('aboutAdmins')}
          </li>
        </ul>
      </div>
    </div>
  );
}
