'use client';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { usePathname, useRouter } from 'next/navigation';

type User = { id: string; name: string; email: string; role: string };
type Screen = { navigate(path: string): void; setTheme(theme: 'light' | 'dark'): void; unmount(): void };
const assets = '/api/pointer-ui/';
const theme = () => document.documentElement.classList.contains('dark') ? 'dark' : 'light';
const pointerPath = (path: string) => {
  const relative = path.replace(/^\/settings\/ai(?=\/|$)/, '') || '/models';
  return relative === '/playground' ? '/test-model' : relative;
};

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  let destination: string;
  if (path === '/v1/models' || path === '/v1/chat/completions') {
    const key = headers.get('authorization')?.replace(/^Bearer /, '');
    init = { ...init, method: 'POST', body: JSON.stringify({ key, operation: path === '/v1/models' ? 'models' : 'chat',
      request: init.body ? JSON.parse(String(init.body)) : undefined, sessionId: headers.get('x-opencode-session') ?? undefined }) };
    destination = '/api/ai-proxy-test';
    headers.delete('authorization'); headers.set('content-type', 'application/json');
  } else {
    if (!path.startsWith('/api/') || /[\\#]/.test(path)) throw new Error('Invalid Pointer request');
    destination = '/api/ai' + path.slice(4);
    headers.delete('authorization');
  }
  if (!['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase())) {
    const response = await fetch('/settings/api/auth/csrf', { cache: 'no-store', signal: init.signal });
    const body = await response.json();
    if (!response.ok || typeof body.csrfToken !== 'string') throw new Error('Could not prepare a protected request');
    headers.set('x-csrf-token', body.csrfToken);
  }
  return fetch(destination, { ...init, headers, cache: 'no-store' });
}

export function PointerConsole({ user }: { user: User }) {
  const pathname = usePathname(), router = useRouter();
  const element = React.useRef<HTMLDivElement>(null), screen = React.useRef<Screen | null>(null);
  const currentPath = React.useRef(pointerPath(pathname));
  const [error, setError] = React.useState(''), [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => { currentPath.current = pointerPath(pathname); screen.current?.navigate(currentPath.current); }, [pathname]);
  React.useEffect(() => {
    const abort = new AbortController();
    const observer = new MutationObserver(() => screen.current?.setTheme(theme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    setError('');
    void (async () => {
      const response = await fetch(assets + 'manifest.json', { cache: 'no-store', signal: abort.signal });
      if (!response.ok) throw new Error('Pointer interface is unavailable');
      const manifest = await response.json();
      if (manifest.contract !== 1 || manifest.react !== '19' || !/^entry-[a-f0-9]{16}\.js$/.test(manifest.entry)
        || !/^styles-[a-f0-9]{16}\.css$/.test(manifest.stylesheet) || !/^fonts-[a-f0-9]{16}\.css$/.test(manifest.fonts)) throw new Error('Unsupported Pointer interface');
      const module = await import(/* webpackIgnore: true */ new URL(assets + manifest.entry, location.origin).href);
      if (abort.signal.aborted) return;
      screen.current = module.createPointerUI({ React, createRoot }).mount(element.current!, {
        assetBase: new URL(assets, location.origin).href, stylesheet: manifest.stylesheet, fonts: manifest.fonts,
        user, request, theme: theme(), path: currentPath.current,
        onNavigate: (path: string) => router.push('/settings/ai' + path),
        onUnauthorized: () => router.refresh(), onSignOut: () => router.push('/settings'),
      });
    })().catch(() => { if (!abort.signal.aborted) setError('Pointer could not load. Other settings remain available.'); });
    return () => { abort.abort(); observer.disconnect(); screen.current?.unmount(); screen.current = null; };
  }, [user.id, user.name, user.email, user.role, attempt, router]);
  return <section aria-label="Pointer" className="min-w-0">
    {error && <div role="alert"><p>{error}</p><button onClick={() => setAttempt(value => value + 1)}>Try again</button></div>}
    <div ref={element} className="min-w-0" />
  </section>;
}
