"use client";






import { useTranslations as useInterfaceTranslations } from "next-intl";
/**
 * Install from URL Dialog
 *
 * Allows admins to paste a manifest YAML URL or Git repository URL,
 * fetch and preview it with a rich detail view, then install the app.
 * Uses the validate-url endpoint for SSRF-safe manifest fetching
 * and schema validation.
 */



import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Loader2, ExternalLink, AlertCircle, Shield, Globe, HardDrive,
  CheckCircle2, X, Tag, ChevronLeft, ChevronRight,
  Package,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { authenticatedFetch } from '@/lib/api-client';
import type { MarketApp, InstallEvent } from '@/lib/market/types';

interface InstallFromUrlDialogProps {
  domain: string;
  onClose: () => void;
  onInstallComplete: () => void;
}

interface ManifestCapabilities {
  sso: boolean;
  sharedPostgres: boolean;
  containers: number;
  language: boolean;
  notifications?: string;
  smtp?: boolean;
}

type Phase = 'input' | 'preview' | 'installing';

export function InstallFromUrlDialog({
  domain,
  onClose,
  onInstallComplete,
}: InstallFromUrlDialogProps) {
  const translateInterface = useInterfaceTranslations("interface");

  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('input');
  const [url, setUrl] = useState('');
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  // Setup files need an explicit approval before the app is added.
  const [pendingSetups, setPendingSetups] = useState<Array<{ name: string; for: string }>>([]);
  const [allowSetup, setAllowSetup] = useState(false);

  // Preview state
  const [preview, setPreview] = useState<MarketApp | null>(null);
  const [capabilities, setCapabilities] = useState<ManifestCapabilities | null>(null);
  const [subdomain, setSubdomain] = useState('');

  // Install state
  const [installEvents, setInstallEvents] = useState<InstallEvent[]>([]);
  const [installDone, setInstallDone] = useState(false);

  // Screenshot lightbox state
  const [selectedScreenshot, setSelectedScreenshot] = useState<number | null>(null);

  // Fetch and validate manifest
  const handleFetch = useCallback(async () => {
    if (!url.trim()) {
      setError(translateInterface("ma58a94b9a403"));
      return;
    }

    setFetching(true);
    setError(null);
    setValidationErrors([]);

    try {
      const res = await authenticatedFetch('/api/market/validate-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifestUrl: url.trim(), addToMarket: true, ...(allowSetup ? { allowSetup: true } : {}) }),
      });

      const data = await res.json();

      if (!data.valid) {
        if (data.setupApprovalRequired && Array.isArray(data.setups)) {
          setPendingSetups(data.setups);
          setValidationErrors([translateInterface("m1d8034f00ca4")]);
          return;
        }
        setValidationErrors(data.errors || [translateInterface("mec4ed30cb031")]);
        return;
      }

      if (typeof data.href === 'string' && data.href.startsWith('/market/')) {
        onClose();
        router.push(data.href);
        return;
      }

      setPreview(data.manifest);
      setCapabilities(data.capabilities);
      setSubdomain(data.manifest.defaultSubdomain || '');
      setPhase('preview');
    } catch (err) {
      setError(translateInterface("mdfcd25c74dda"));
    } finally {
      setFetching(false);
    }
  }, [url, allowSetup, onClose, router, translateInterface]);

  // Install from URL
  const handleInstall = useCallback(async () => {
    if (!preview || !subdomain) return;

    setPhase('installing');
    setInstallEvents([]);
    setInstallDone(false);

    try {
      const res = await authenticatedFetch('/api/market/install-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifestUrl: url.trim(),
          subdomain,
          domain,
          ...(allowSetup ? { allowSetup: true } : {}),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      // Read SSE stream
      const reader = res.body?.getReader();
      if (!reader) throw new Error(translateInterface("mfc992827aa0d"));

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const cleaned = line.replace(/^data: /, '').trim();
          if (!cleaned) continue;
          try {
            const event: InstallEvent = JSON.parse(cleaned);
            setInstallEvents(prev => {
              const existing = prev.findIndex(
                e => e.step === event.step && e.status === 'running'
              );
              if (existing >= 0 && event.status !== 'running') {
                const updated = [...prev];
                updated[existing] = event;
                return updated;
              }
              return [...prev, event];
            });
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      setInstallEvents(prev => [
        ...prev,
        { step: 0, totalSteps: 0, status: 'error', message: translateInterface("md472ecf6a07e"), detail: String(err) },
      ]);
    } finally {
      setInstallDone(true);
    }
  }, [url, preview, subdomain, domain, allowSetup, translateInterface]);

  const longDescription = preview?.detail?.longDescription || preview?.description;
  const screenshots = preview?.detail?.screenshots ?? [];

  // Determine dialog width based on phase
  const dialogMaxWidth = phase === 'preview' ? 'max-w-3xl' : 'max-w-lg';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className={`bg-white rounded-xl shadow-2xl w-full ${dialogMaxWidth} mx-4 max-h-[85vh] overflow-y-auto`}>
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Globe className="h-5 w-5 text-blue-600" />
            {translateInterface("mc7d5009dc83d")}</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Phase 1: URL Input */}
          {phase === 'input' && (
            <>
              <div className="space-y-2">
                <Label htmlFor="manifestUrl">{translateInterface("m4ddcf63f0783")}</Label>
                <div className="flex gap-2">
                  <Input
                    id="manifestUrl"
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    placeholder={translateInterface("ma7881538cca9")}
                    disabled={fetching}
                    onKeyDown={e => { if (e.key === 'Enter' && url.trim()) handleFetch(); }}
                  />
                  <Button onClick={handleFetch} disabled={fetching || !url.trim()}>
                    {fetching ? <Loader2 className="h-4 w-4 animate-spin" /> : translateInterface("mcd7d61bf7e38")}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {translateInterface("m267b80abd05f")}</p>
              </div>

              {/* Security notice */}
              <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
                <Shield className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  {translateInterface("mcbc3a0167f8a")}</span>
              </div>

              {error && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {validationErrors.length > 0 && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 space-y-1">
                  <p className="text-sm font-medium text-red-700">{translateInterface("m4a5f7bc35137")}</p>
                  <ul className="text-xs text-red-600 space-y-1 list-disc list-inside">
                    {validationErrors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}

              {pendingSetups.length > 0 && (
                <div className="space-y-2 rounded-lg border p-3">
                  <p className="text-sm font-medium">{translateInterface("m8977bde3d0f7")}</p>
                  <p className="text-xs text-muted-foreground">{translateInterface("m41a1b4787986")}</p>
                  <ul className="space-y-1 text-xs">
                    {pendingSetups.map((setup) => (
                      <li key={setup.name} className="flex justify-between gap-3">
                        <span className="font-mono">{setup.name}</span>
                        <span className="text-muted-foreground">{setup.for}</span>
                      </li>
                    ))}
                  </ul>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input type="checkbox" checked={allowSetup} onChange={(event) => setAllowSetup(event.target.checked)} />
                    {translateInterface("m2514aaccdb83")}</label>
                </div>
              )}
            </>
          )}

          {/* Phase 2: Rich Detail Preview */}
          {phase === 'preview' && preview && (
            <>
              {/* Header card — mirrors the detail page layout */}
              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <div className="flex items-start gap-4">
                  {/* App icon */}
                  <div className="p-3 rounded-xl flex items-center justify-center shrink-0">
                    {preview.iconUrl ? (
                      <Image
                        src={preview.iconUrl}
                        alt={preview.name}
                        width={40}
                        height={40}
                        className="h-10 w-10 object-contain"
                        unoptimized
                      />
                    ) : (
                      <span className="text-3xl">{preview.icon || <Package className="h-10 w-10 text-blue-600" />}</span>
                    )}
                  </div>

                  {/* App info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-xl font-bold text-gray-900">{preview.name}</h3>
                      {preview.version && (
                        <Badge variant="outline" className="text-xs">
                          v{preview.version}
                        </Badge>
                      )}
                      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-gray-50 text-gray-500 border border-gray-200">
                        <Globe className="h-3 w-3" />
                        {translateInterface("m68c114ea9c8c")}</span>
                    </div>
                    <p className="text-sm text-gray-400 capitalize mt-1">
                      {translateInterface("mb330d6701b55")}{preview.category}
                    </p>
                  </div>
                </div>

                {/* Third-party warning */}
                <div className="flex items-start gap-2 p-2 rounded bg-amber-50 text-xs text-amber-800 mt-3">
                  <Shield className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>{translateInterface("m017cf51caeee")}</span>
                </div>
              </div>

              {/* Description section */}
              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  {translateInterface("m526e0087cc3f")}</h4>
                <div className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">
                  {longDescription}
                </div>
              </div>

              {/* Screenshots gallery */}
              {screenshots.length > 0 && (
                <div className="rounded-xl border border-gray-200 bg-white p-5">
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    {translateInterface("m067348ce6894")}</h4>
                  <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-thin">
                    {screenshots.map((shot, i) => (
                      <button
                        key={i}
                        onClick={() => setSelectedScreenshot(i)}
                        className="shrink-0 rounded-lg overflow-hidden border border-gray-200 hover:border-blue-400 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2"
                      >
                        <Image
                          src={shot.url}
                          alt={shot.caption || translateInterface("m7e71e3bb6213", { value0: String(i + 1) })}
                          width={240}
                          height={150}
                          className="h-[150px] w-auto object-cover"
                          unoptimized
                        />
                        {shot.caption && (
                          <p className="text-xs text-gray-500 px-2 py-1 bg-gray-50 truncate max-w-[240px]">
                            {shot.caption}
                          </p>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Resource details */}
              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                  {translateInterface("m45989de49fb7")}</h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {/* SSO */}
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 rounded-lg bg-gray-50">
                      <Shield className="h-3.5 w-3.5 text-gray-500" />
                    </div>
                    <div>
                      <p className="text-xs text-gray-400">SSO</p>
                      <p className="text-sm font-medium text-gray-700">
                        {capabilities?.sso ? (
                          <span className="text-green-600">{translateInterface("mc165800065d1")}</span>
                        ) : (
                          <span className="text-gray-400">{translateInterface("m1ea442a134b2")}</span>
                        )}
                      </p>
                    </div>
                  </div>

                  {/* Containers */}
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 rounded-lg bg-gray-50">
                      <HardDrive className="h-3.5 w-3.5 text-gray-500" />
                    </div>
                    <div>
                      <p className="text-xs text-gray-400">{translateInterface("ma22daa7f02a2")}</p>
                      <p className="text-sm font-medium text-gray-700">
                        {translateInterface("containerCount", {count: capabilities?.containers ?? 0})}
                      </p>
                    </div>
                  </div>

                  {/* Shared DB */}
                  {capabilities?.sharedPostgres && (
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 rounded-lg bg-gray-50">
                        <HardDrive className="h-3.5 w-3.5 text-green-500" />
                      </div>
                      <div>
                        <p className="text-xs text-gray-400">{translateInterface("mfa7fe67124e9")}</p>
                        <p className="text-sm font-medium text-green-600">{translateInterface("mec9b941c227c")}</p>
                      </div>
                    </div>
                  )}

                  {/* Website */}
                  {preview.website && (
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 rounded-lg bg-gray-50">
                        <ExternalLink className="h-3.5 w-3.5 text-gray-500" />
                      </div>
                      <div>
                        <p className="text-xs text-gray-400">{translateInterface("mb5a229ac8bec")}</p>
                        <a
                          href={preview.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-medium text-blue-600 hover:underline"
                        >
                          {(() => {
                            try { return new URL(preview.website).hostname; }
                            catch { return preview.website; }
                          })()}
                        </a>
                      </div>
                    </div>
                  )}
                </div>

                {/* Tags */}
                {preview.tags && preview.tags.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-gray-100">
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <Tag className="h-3.5 w-3.5 text-gray-400" />
                      <p className="text-xs text-gray-400 uppercase tracking-wide font-medium">{translateInterface("m1331275bc537")}</p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {preview.tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Install config — subdomain input */}
              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                  {translateInterface("m8da653cc3d8d")}</h4>
                <div className="space-y-2">
                  <Label htmlFor="subdomain">{translateInterface("mba4520ab4f25")}</Label>
                  <div className="flex items-center gap-1">
                    <Input
                      id="subdomain"
                      value={subdomain}
                      onChange={e => setSubdomain(e.target.value)}
                      placeholder="app"
                      className="flex-1"
                    />
                    <span className="text-sm text-muted-foreground">.{domain}</span>
                  </div>
                </div>
              </div>

              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setPhase('input')}>
                  {translateInterface("m76900f1bfd16")}</Button>
                <Button
                  className="flex-1"
                  onClick={handleInstall}
                  disabled={!subdomain.trim()}
                >
                  {translateInterface("m569ca49f4aaf")}{" "}{preview.name}
                </Button>
              </div>
            </>
          )}

          {/* Phase 3: Installing */}
          {phase === 'installing' && (
            <>
              <div className="space-y-3">
                {installEvents.map((event, i) => (
                  <div key={i} className="flex items-start gap-3">
                    {event.status === 'running' ? (
                      <Loader2 className="h-4 w-4 animate-spin text-primary mt-0.5" />
                    ) : event.status === 'success' ? (
                      <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5" />
                    ) : event.status === 'error' ? (
                      <AlertCircle className="h-4 w-4 text-red-600 mt-0.5" />
                    ) : null}
                    <div>
                      <p className={`text-sm ${event.status === 'running' ? 'font-medium' : ''}`}>
                        {event.message}
                      </p>
                      {event.detail && (
                        <p className="text-xs text-muted-foreground mt-0.5">{event.detail}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {installDone && (
                <Button
                  className="w-full"
                  onClick={() => {
                    onInstallComplete();
                    onClose();
                  }}
                >
                  {translateInterface("m11a6767d5674")}</Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Screenshot lightbox — rendered outside the dialog scroll area */}
      {selectedScreenshot !== null && screenshots.length > 0 && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setSelectedScreenshot(null)}
        >
          <div
            className="relative max-w-[90vw] max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
          >
            {selectedScreenshot > 0 && (
              <button
                onClick={() => setSelectedScreenshot(selectedScreenshot - 1)}
                className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 z-10"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}
            {selectedScreenshot < screenshots.length - 1 && (
              <button
                onClick={() => setSelectedScreenshot(selectedScreenshot + 1)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 z-10"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            )}

            <Image
              src={screenshots[selectedScreenshot].url}
              alt={screenshots[selectedScreenshot].caption || translateInterface("m7e71e3bb6213", { value0: String(selectedScreenshot + 1) })}
              width={1200}
              height={800}
              className="rounded-lg max-h-[85vh] w-auto object-contain"
              unoptimized
            />

            {screenshots[selectedScreenshot].caption && (
              <p className="text-center text-sm text-white/80 mt-3">
                {screenshots[selectedScreenshot].caption}
              </p>
            )}

            <p className="text-center text-xs text-white/50 mt-1">
              {selectedScreenshot + 1} / {screenshots.length}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
