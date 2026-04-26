/**
 * PIN Prompt
 *
 * Modal dialog for entering or creating an encryption PIN.
 * Shows different UI for first-time setup vs. session unlock.
 */

"use client";

import { useState } from "react";
import { Lock, Eye, EyeOff, Shield, KeyRound } from "lucide-react";
import { useTranslations } from "next-intl";

interface PINPromptProps {
  mode: "create" | "verify";
  onSuccess: () => void;
  onCancel?: () => void;
  /** When true, renders inline without the modal overlay/card wrapper (for use inside onboarding) */
  embedded?: boolean;
}

export function PINPrompt({ mode, onSuccess, onCancel, embedded }: PINPromptProps) {
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const t = useTranslations('pinPrompt');
  const tc = useTranslations('common');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (mode === "create") {
      if (pin.length < 4) {
        setError(t('pinMinLength'));
        return;
      }
      if (pin !== confirmPin) {
        setError(t('pinMismatch'));
        return;
      }
    }

    setLoading(true);
    try {
      const endpoint =
        mode === "create" ? "/api/v1/pin/create" : "/api/v1/pin/verify";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed");
        return;
      }

      onSuccess();
    } catch {
      setError(tc('networkError'));
    } finally {
      setLoading(false);
    }
  };

  const formContent = (
    <form onSubmit={handleSubmit} className={embedded ? "space-y-4" : "p-6 space-y-4"}>
      <div>
        <label className={`block text-sm font-medium mb-1.5 ${embedded ? "text-muted-foreground" : ""}`}>
          {mode === "create" ? t('choosePin') : t('enterPin')}
        </label>
        <div className="relative">
          <Lock className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground`} />
          <input
            type={showPin ? "text" : "password"}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder={t('enterPinPlaceholder')}
            className={embedded
              ? "w-full pl-10 pr-10 py-2.5 bg-muted border border-border rounded-xl text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              : "w-full pl-10 pr-10 py-2.5 bg-muted rounded-lg border-0 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            }
            autoFocus
            autoComplete="off"
          />
          <button
            type="button"
            onClick={() => setShowPin(!showPin)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {showPin ? (
              <EyeOff className="w-4 h-4" />
            ) : (
              <Eye className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {mode === "create" && (
        <div>
          <label className={`block text-sm font-medium mb-1.5 ${embedded ? "text-muted-foreground" : ""}`}>
            {t('confirmPin')}
          </label>
          <div className="relative">
            <Lock className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground`} />
            <input
              type={showPin ? "text" : "password"}
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value)}
              placeholder={t('confirmPinPlaceholder')}
              className={embedded
                ? "w-full pl-10 pr-4 py-2.5 bg-muted border border-border rounded-xl text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                : "w-full pl-10 pr-4 py-2.5 bg-muted rounded-lg border-0 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              }
              autoComplete="off"
            />
          </div>
        </div>
      )}

      {error && (
        <p className="text-sm text-center text-red-500">{error}</p>
      )}

      <div className="flex gap-3 pt-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className={embedded
              ? "flex-1 py-2.5 text-sm rounded-xl bg-transparent border border-border text-muted-foreground hover:text-foreground hover:border-border/80 transition-colors"
              : "flex-1 py-2.5 text-sm rounded-lg border hover:bg-accent transition-colors"
            }
          >
            {tc('cancel')}
          </button>
        )}
        <button
          type="submit"
          disabled={loading || pin.length < 4}
          className={embedded
            ? "flex-1 py-2.5 text-sm rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-medium transition-colors disabled:opacity-50"
            : "flex-1 py-2.5 text-sm rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          }
        >
          {loading
            ? t('processing')
            : mode === "create"
            ? t('createPin')
            : tc('unlock')}
        </button>
      </div>

      {mode === "create" && (
        <p className="text-xs text-center text-muted-foreground">
          {t('pinRecoveryWarning')}
        </p>
      )}
    </form>
  );

  if (embedded) {
    return formContent;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm mx-4 bg-card border rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-r from-violet-600 to-purple-600 p-6 text-white text-center">
          <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-white/20 flex items-center justify-center">
            {mode === "create" ? (
              <Shield className="w-6 h-6" />
            ) : (
              <KeyRound className="w-6 h-6" />
            )}
          </div>
          <h2 className="text-lg font-semibold">
            {mode === "create"
              ? t('setupTitle')
              : t('unlockTitle')}
          </h2>
          <p className="text-sm text-white/80 mt-1">
            {mode === "create"
              ? t('setupDescription')
              : t('unlockDescription')}
          </p>
        </div>

        {formContent}
      </div>
    </div>
  );
}
