'use client';


import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useLocale } from "next-intl";
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { AI_SECTIONS } from './ai-navigation';
import { useRef as useInterfaceTranslationRef } from "react";

type User = { id: string; name: string; email: string; role: string };
type Screen = { setLocale?(locale: string): void; navigate(path: string): void; setTheme(theme: 'light' | 'dark'): void; unmount(): void };
const assets = '/api/pointer-ui/';
const theme = () => document.documentElement.classList.contains('dark') ? 'dark' : 'light';
const pointerPath = (path: string) => path.replace(/^\/settings\/ai(?=\/|$)/, '') || '/models';

function PointerLoading({ path }: { path: string }) {
  const aiNavigation = useInterfaceTranslations("aiNavigation");
  const [, section, detail] = path.split('/');
  const labelKey = AI_SECTIONS.find(item => item.href === `/${section}`)?.labelKey
    ?? (section === 'admin' ? 'admin' : 'settings');
  const title = aiNavigation(labelKey);
  const rows = !detail && ['models', 'instances'].includes(section);
  const form = detail || ['routing', 'test-model'].includes(section);
  const bar = 'block rounded bg-muted motion-safe:animate-pulse';
  return <div role="status" aria-label={aiNavigation("loading", { section: title })} aria-busy="true" className="space-y-6 py-2">
    <div aria-hidden="true" className="space-y-6">
      <div className="space-y-3"><h1 className="text-2xl font-semibold">{detail ? <span className={`${bar} h-8 w-56`} /> : title}</h1><span className={`${bar} h-4 w-2/3`} /></div>
      {rows ? <>
        {section === 'models' && <div className="flex flex-wrap gap-3 rounded-lg border bg-card p-4">{[1, 2, 3, 4].map(value => <span key={value} className={`${bar} h-10 w-36`} />)}</div>}
        <div className="overflow-hidden rounded-lg border bg-card">
          {Array.from({ length: 7 }, (_, row) => <div key={row} className="flex gap-6 border-b p-5 last:border-0">{[1, 2, 3, 4].map(column => <span key={column} className={`${bar} h-4 flex-1`} />)}</div>)}
        </div>
      </> : form ? <div className="space-y-4 rounded-lg border bg-card p-5">{[1, 2, 3].map(value => <div key={value} className="space-y-2"><span className={`${bar} h-4 w-28`} /><span className={`${bar} h-10 w-full`} /></div>)}</div>
        : <div className={`grid gap-4 ${section === 'dashboard' ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>{[1, 2, 3, ...(section === 'dashboard' ? [4] : [])].map(value => <div key={value} className="space-y-4 rounded-lg border bg-card p-5"><span className={`${bar} h-4 w-2/3`} /><span className={`${bar} h-8 w-1/2`} /><span className={`${bar} h-4 w-1/3`} /></div>)}</div>}
    </div>
  </div>;
}

async function request(path: string, init: RequestInit, translateInterface: (key: string) => string) {
  const headers = new Headers(init.headers);
  let destination: string;
  if (path === '/v1/models' || path === '/v1/chat/completions') {
    const key = headers.get('authorization')?.replace(/^Bearer /, '');
    init = { ...init, method: 'POST', body: JSON.stringify({ key, operation: path === '/v1/models' ? 'models' : 'chat',
      request: init.body ? JSON.parse(String(init.body)) : undefined, sessionId: headers.get('x-opencode-session') ?? undefined }) };
    destination = '/settings/api/ai-proxy-test';
    headers.delete('authorization'); headers.set('content-type', 'application/json');
  } else {
    if (!path.startsWith('/api/') || /[\\#]/.test(path)) throw new Error(translateInterface("md3a811b38e16"));
    // The root service worker can change the fetch referrer. Use the explicit
    // control namespace rather than the Referer-selected root API.
    destination = '/settings/api/ai' + path.slice(4);
    headers.delete('authorization');
  }
  if (!['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase())) {
    const response = await fetch('/settings/api/auth/csrf', { cache: 'no-store', signal: init.signal });
    const body = await response.json();
    if (!response.ok || typeof body.csrfToken !== 'string') throw new Error(translateInterface("mfdd8ed13bfe2"));
    headers.set('x-csrf-token', body.csrfToken);
  }
  return fetch(destination, { ...init, headers, cache: 'no-store' });
}

export function PointerConsole({ user }: { user: User }) {
  const translateInterface = useInterfaceTranslations("interface");
  const interfaceTranslationRef = useInterfaceTranslationRef(translateInterface);
  interfaceTranslationRef.current = translateInterface;
  const locale = useLocale();
  const translationRef = React.useRef(translateInterface);
  translationRef.current = translateInterface;
  const localeRef = React.useRef(locale);
  localeRef.current = locale;
  const pointerRequest = React.useCallback((path: string, init: RequestInit = {}) => request(path, init, translationRef.current), []);
  const { id, name, email, role } = user;
  const pathname = usePathname(), router = useRouter();
  const element = React.useRef<HTMLDivElement>(null), screen = React.useRef<Screen | null>(null);
  const currentPath = React.useRef(pointerPath(pathname));
  const [error, setError] = React.useState(''), [attempt, setAttempt] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => { currentPath.current = pointerPath(pathname); screen.current?.navigate(currentPath.current); }, [pathname]);
  React.useEffect(() => { screen.current?.setLocale?.(locale); }, [locale]);
  React.useEffect(() => {
    setLoading(true);
    setError('');
    const abort = new AbortController();
    const observer = new MutationObserver(() => screen.current?.setTheme(theme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    void (async () => {
      const response = await fetch(assets + 'manifest.json', { cache: 'no-store', signal: abort.signal });
      if (!response.ok) throw new Error(translationRef.current("mbc811138f0df"));
      const manifest = await response.json();
      if (manifest.contract !== 1 || manifest.react !== '19' || !/^entry-[a-f0-9]{16}\.js$/.test(manifest.entry)
        || !/^styles-[a-f0-9]{16}\.css$/.test(manifest.stylesheet) || !/^fonts-[a-f0-9]{16}\.css$/.test(manifest.fonts)) throw new Error(translationRef.current("m5adbd507e6c0"));
      const loadedModule = await import(/* webpackIgnore: true */ new URL(assets + manifest.entry, location.origin).href);
      if (abort.signal.aborted) return;
      screen.current = loadedModule.createPointerUI({ React, createRoot }).mount(element.current!, {
        assetBase: new URL(assets, location.origin).href, stylesheet: manifest.stylesheet, fonts: manifest.fonts,
        user: { id, name, email, role }, request: pointerRequest, theme: theme(), path: currentPath.current,
        locale: localeRef.current,
        navigation: 'host',
        onNavigate: (path: string) => router.push('/settings/ai' + path),
        onUnauthorized: () => router.refresh(), onSignOut: () => router.push('/settings'),
      });
      setLoading(false);
    })().catch(() => { if (!abort.signal.aborted) setError(interfaceTranslationRef.current("m7b1850994da3")); });
    return () => { abort.abort(); observer.disconnect(); screen.current?.unmount(); screen.current = null; };
  }, [id, name, email, role, attempt, router, pointerRequest]);
  return <section aria-label={translateInterface("m377c481d3c31")} className="settings-pointer-theme min-w-0">
    {loading && !error && <PointerLoading path={pointerPath(pathname)} />}
    {error && <div role="alert" className="space-y-3 rounded-lg border bg-card p-5 text-sm">
      <p>{error}</p><Button variant="outline" onClick={() => { setError(''); setLoading(true); setAttempt(value => value + 1); }}>{translateInterface("md8b8392e2c54")}</Button>
    </div>}
    <div ref={element} className="settings-pointer min-w-0" aria-busy={loading && !error} />
  </section>;
}
