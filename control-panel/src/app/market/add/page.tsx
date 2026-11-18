'use client';

/**
 * "Add to YouEye" links: /market/add?market=<https address> or ?app=<https manifest URL>.
 *
 * A link alone never changes anything. This page renders nothing from the link itself: once it has rendered, it asks
 * the admin API (`POST /api/market/add/preview` with the CSRF token, which checks the link, reads the market or app and
 * writes nothing) and shows its answer; an answer that is not a preview (a refusal) is shown as its plain message, with
 * nothing to add. Adding is the owner's choice, through the same guarded calls as the sources page and the "Install
 * from address" dialog; installing an app is a separate step on its page.
 */
import { useTranslations as useInterfaceTranslations } from "next-intl";
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, Check, ChevronLeft, Loader2, Shield, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MarketPreview, type MarketPreviewData } from '@/components/market/market-preview';
import { authenticatedFetch } from '@/lib/api-client';

/** What `POST /api/market/add/preview?app=…` says about an app. */
interface AppPreviewData {
  kind: 'app';
  url: string;
  host: string;
  id: string;
  name: string;
  version: string | null;
  images: string[];
  setups: string[];
  already_added: string | null;
}

type Preview = MarketPreviewData | AppPreviewData;

export default function AddToYouEyePage() {
  return (
    <Suspense fallback={<div className="flex h-64 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-primary" /></div>}>
      <AddFromLink />
    </Suspense>
  );
}

function AddFromLink() {
  const translateInterface = useInterfaceTranslations("interface");
  const router = useRouter();
  const searchParams = useSearchParams();
  const query = searchParams.toString();

  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setPreview(null);
    setTrusted(false);
    authenticatedFetch(`/api/market/add/preview?${query}`, { method: 'POST', cache: 'no-store' })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!active) return;
        if (!res.ok || (data.kind !== 'market' && data.kind !== 'app')) {
          const details = Array.isArray(data.details) ? `: ${data.details.join('; ')}` : '';
          setError(typeof data.error === 'string' ? `${data.error}${details}` : translateInterface("m5adf64deb21d"));
          return;
        }
        setPreview(data as Preview);
      })
      .catch(() => { if (active) setError(translateInterface("m5adf64deb21d")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [query, translateInterface]);

  const add = async () => {
    if (!preview || preview.already_added || !trusted) return;
    setAdding(true);
    setAddError(null);
    try {
      if (preview.kind === 'market') {
        // The owner's tick is the consent: the market is added and accepted.
        const res = await authenticatedFetch('/api/market/source', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: preview.address, acceptRisk: true }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : translateInterface("m3a1797265a2e"));
        router.push('/market/sources');
        return;
      }
      // An app is added to the Market (not installed): Install is the next step, on its page.
      const res = await authenticatedFetch('/api/market/validate-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifestUrl: preview.url, addToMarket: true, ...(preview.setups.length ? { allowSetup: true } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.valid || typeof data.href !== 'string' || !data.href.startsWith('/market/')) {
        throw new Error(Array.isArray(data.errors) && data.errors.length ? data.errors.join('; ') : translateInterface("m3a1797265a2e"));
      }
      router.push(data.href);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : translateInterface("m3a1797265a2e"));
      setAdding(false);
    }
  };

  const back = (
    <Link href="/market" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
      <ChevronLeft className="h-4 w-4" /> {" "}{translateInterface("m7e0461b96831")}</Link>
  );

  if (loading) {
    return (
      <div className="mx-auto max-w-[640px] space-y-6 px-1 pb-16">
        {back}
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />{translateInterface("m691e2a1bd9e8")}</div>
      </div>
    );
  }

  if (error || !preview) {
    return (
      <div className="mx-auto max-w-[640px] space-y-6 px-1 pb-16">
        {back}
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />{translateInterface("mc6c4ed266137")}</p>
          <p className="mt-1 break-words text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  const isMarket = preview.kind === 'market';
  const address = isMarket ? preview.address : preview.url;
  const existingHref = preview.already_added
    ? (isMarket ? '/market/sources' : `/market/${encodeURIComponent(preview.id)}?source=${encodeURIComponent(preview.already_added)}`)
    : null;

  return (
    <div className="mx-auto max-w-[640px] space-y-6 px-1 pb-16">
      {back}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {isMarket ? translateInterface("mbe35e5af80e2") : translateInterface("me700e6f9f7b4")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{translateInterface("m561412f1ea64")}</p>
      </div>

      <section className="space-y-4 rounded-xl border bg-card p-5">
        <div className="space-y-1">
          <p className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">{translateInterface("m56ef8f20955f")}</p>
          <p className="break-all rounded-lg border bg-muted/40 p-3 font-mono text-[12.5px] text-foreground">{address}</p>
        </div>

        {isMarket ? (
          <MarketPreview preview={preview} />
        ) : (
          <div className="space-y-2 rounded-lg border bg-card p-3 text-[13px]">
            <p className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">{translateInterface("ma259dd3e8b14")}</p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">{translateInterface("mdcd1d5223f73")}</dt>
              <dd className="break-words font-medium text-foreground">{preview.name}</dd>
              <dt className="text-muted-foreground">{translateInterface("mdd167905de0d")}</dt>
              <dd className="font-medium text-foreground">{preview.version ?? '—'}</dd>
              <dt className="text-muted-foreground">{translateInterface("maef7de28d529")}</dt>
              <dd className="break-all font-mono text-foreground">{preview.host}</dd>
            </dl>
            <div>
              <p className="text-muted-foreground">{translateInterface("mbe7e2f201293")}</p>
              <ul className="mt-0.5 space-y-0.5">
                {preview.images.map((image) => <li key={image} className="break-all font-mono text-[12px] text-foreground">{image}</li>)}
              </ul>
            </div>
            <div>
              <p className="text-muted-foreground">{translateInterface("m8977bde3d0f7")}</p>
              {preview.setups.length ? (
                <ul className="mt-0.5 space-y-0.5">
                  {preview.setups.map((setup) => <li key={setup} className="break-all font-mono text-[12px] text-foreground">{setup}</li>)}
                </ul>
              ) : (
                <p className="text-foreground">{translateInterface("ma653dc1983d6")}</p>
              )}
            </div>
          </div>
        )}

        {existingHref ? (
          <p className="text-sm text-foreground">
            {isMarket ? translateInterface("mb7a1bb084dc2") : translateInterface("me83716bcb330")}{" "}
            <Link href={existingHref} className="font-medium text-primary hover:underline">
              {isMarket ? translateInterface("m81393d1e2beb") : translateInterface("macfe1b406141")}</Link>
          </p>
        ) : (
          <>
            <p className="flex items-start gap-2 text-[13px] text-amber-700 dark:text-amber-500">
              {isMarket ? <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> : <Shield className="mt-0.5 h-4 w-4 shrink-0" />}
              {isMarket ? translateInterface("mbfa5007b34bb") : translateInterface("mcbc3a0167f8a")}</p>
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-foreground">
              <input type="checkbox" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} />
              {isMarket
                ? translateInterface("m2dca61bd9de2")
                : preview.setups.length ? translateInterface("m5ae862f2c24b") : translateInterface("m1faaa3bf1aac")}</label>
            {addError && <p role="alert" className="break-words text-sm text-destructive">{addError}</p>}
            <div className="flex flex-wrap gap-2">
              <Button onClick={add} disabled={!trusted || adding}>
                {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {" "}{translateInterface("m9fd728c66c9a")}</Button>
              <Button variant="outline" onClick={() => router.push('/market')} disabled={adding}>
                {translateInterface("m19766ed6ccb2")}</Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
