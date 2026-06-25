'use client';

import { useState } from 'react';
import { Shield, ShieldCheck, ShieldOff, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { authenticatedFetch } from '@/lib/api-client';

interface ForwardAuthToggleProps {
  appId: string;
  /** Whether the app has native OAuth2 SSO */
  hasNativeSSO: boolean;
  /** Current forward-auth state from status API */
  forwardAuthEnabled: boolean;
  /** Callback after toggle succeeds */
  onToggled?: (enabled: boolean) => void;
}

export function ForwardAuthToggle({
  appId,
  hasNativeSSO,
  forwardAuthEnabled,
  onToggled,
}: ForwardAuthToggleProps) {
  const [toggling, setToggling] = useState(false);
  const [enabled, setEnabled] = useState(forwardAuthEnabled);

  if (hasNativeSSO) {
    return (
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-blue-50">
          <ShieldCheck className="h-4 w-4 text-blue-600" />
        </div>
        <div>
          <p className="text-xs text-gray-400">SSO Protection</p>
          <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
            OAuth2 (native)
          </Badge>
        </div>
      </div>
    );
  }

  const handleToggle = async () => {
    setToggling(true);
    try {
      const res = await authenticatedFetch('/api/market/forward-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, enabled: !enabled }),
      });
      if (res.ok) {
        const data = await res.json();
        setEnabled(data.forwardAuthEnabled);
        onToggled?.(data.forwardAuthEnabled);
      }
    } catch {
      // Revert on failure
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <div className={`p-2 rounded-lg ${enabled ? 'bg-green-50' : 'bg-gray-50'}`}>
        {enabled ? (
          <ShieldCheck className="h-4 w-4 text-green-600" />
        ) : (
          <ShieldOff className="h-4 w-4 text-gray-400" />
        )}
      </div>
      <div className="flex-1">
        <p className="text-xs text-gray-400">SSO Protection</p>
        <p className="text-sm font-medium text-gray-700">
          {enabled ? 'Forward-auth enabled' : 'No SSO protection'}
        </p>
      </div>
      <button
        onClick={handleToggle}
        disabled={toggling}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 ${
          enabled ? 'bg-green-500' : 'bg-gray-300'
        } ${toggling ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
      >
        {toggling ? (
          <span className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="h-3 w-3 animate-spin text-white" />
          </span>
        ) : (
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
              enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        )}
      </button>
    </div>
  );
}

/** Compact SSO indicator for app cards */
export function SSOIndicator({
  hasNativeSSO,
  forwardAuthEnabled,
}: {
  hasNativeSSO: boolean;
  forwardAuthEnabled?: boolean;
}) {
  if (hasNativeSSO) {
    return (
      <span title="OAuth2 SSO (native)">
        <Shield className="h-3.5 w-3.5 text-blue-500" />
      </span>
    );
  }
  if (forwardAuthEnabled) {
    return (
      <span title="Forward-auth SSO enabled">
        <ShieldCheck className="h-3.5 w-3.5 text-green-500" />
      </span>
    );
  }
  return (
    <span title="No SSO protection">
      <ShieldOff className="h-3.5 w-3.5 text-gray-300" />
    </span>
  );
}
