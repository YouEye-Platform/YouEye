'use client';

import { useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { Lock, User, AlertCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ROOT_TREE_ART } from './root-tree-art';

interface LoginFormProps {
  initialError?: string | null;
  settingsFlow?: boolean;
}

export function LoginForm({ initialError = null, settingsFlow = false }: LoginFormProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(initialError);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [username, setUsername] = useState('root');
  const t = useTranslations('login');
  const authBase = settingsFlow ? '/settings/api/auth' : '/api/auth';
  const showRootTree = username.trim() === 'root';
  const prompt = showRootTree
    ? 'Enter your root password'
    : 'Sign in with your Linux system credentials';

  async function handleSubmit(formData: FormData) {
    setError(null);
    setRemaining(null);

    const username = formData.get('username') as string;
    const password = formData.get('password') as string;

    if (!username || !password) {
      setError('Please enter both username and password');
      return;
    }

    try {
      const response = await fetch(`${authBase}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Login failed');
        if (data.remaining !== undefined) {
          setRemaining(data.remaining);
        }
        return;
      }

      startTransition(() => {
        const host = window.location.host;
        const hostname = host.split(':')[0];
        const port = host.split(':')[1];
        const isIP = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
        const isDirectControlAccess = (isIP || hostname === 'localhost' || hostname === '127.0.0.1') && port === '3000';
        const isCaddyAccess = isIP && port !== '3000';

        if (isCaddyAccess) {
          router.push('/setup');
        } else if (isDirectControlAccess) {
          router.push('/settings/system');
        } else if (settingsFlow || pathname.startsWith('/settings')) {
          router.push('/settings');
        } else {
          router.push('/');
        }
        router.refresh();
      });
    } catch (err) {
      console.error('Login error:', err);
      setError('Network error. Please try again.');
    }
  }

  return (
    <div
      className={cn(
        'relative flex min-h-screen w-full items-center justify-center overflow-hidden px-6 py-10 transition-colors duration-300',
        showRootTree ? 'bg-black text-amber-100' : 'bg-background text-foreground'
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none fixed inset-0 z-0 flex items-center justify-center overflow-hidden transition-opacity duration-500',
          showRootTree ? 'opacity-100' : 'opacity-0'
        )}
      >
        <pre className="select-none font-mono text-[clamp(17px,1.75vw,31px)] leading-[0.78] tracking-normal text-amber-500/30 [text-shadow:0_0_18px_rgba(245,158,11,0.22)]">
          {ROOT_TREE_ART.join('\n')}
        </pre>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(0,0,0,0.18),rgba(0,0,0,0.82)_72%,#000_100%)]" />
      </div>

      <form action={handleSubmit} className="relative z-10 w-full max-w-[360px] space-y-3">
        <p
          className={cn(
            'mb-5 text-center text-sm font-medium',
            showRootTree ? 'text-amber-200' : 'text-muted-foreground'
          )}
        >
          {prompt}
        </p>

        {error && (
          <Alert variant="destructive" className="bg-background/95">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {error}
              {remaining !== null && remaining > 0 && (
                <span className="mt-1 block text-sm">
                  {remaining} attempt{remaining !== 1 ? 's' : ''} remaining
                </span>
              )}
            </AlertDescription>
          </Alert>
        )}

        <div className="relative">
          <Label htmlFor="username" className="sr-only">
            {t('username')}
          </Label>
          <User
            className={cn(
              'absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2',
              showRootTree ? 'text-amber-500/75' : 'text-muted-foreground'
            )}
          />
          <Input
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className={cn(
              'h-11 pl-10 shadow-none',
              showRootTree
                ? 'border-amber-500/45 bg-black/70 text-amber-100 placeholder:text-amber-700 focus-visible:border-amber-300 focus-visible:ring-amber-400/30'
                : 'bg-background/90'
            )}
          />
        </div>

        <div className="relative">
          <Label htmlFor="password" className="sr-only">
            {t('password')}
          </Label>
          <Lock
            className={cn(
              'absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2',
              showRootTree ? 'text-amber-500/75' : 'text-muted-foreground'
            )}
          />
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            className={cn(
              'h-11 pl-10 shadow-none',
              showRootTree
                ? 'border-amber-500/45 bg-black/70 text-amber-100 placeholder:text-amber-700 focus-visible:border-amber-300 focus-visible:ring-amber-400/30'
                : 'bg-background/90'
            )}
          />
        </div>

        <Button
          type="submit"
          disabled={isPending}
          className={cn(
            'h-11 w-full',
            showRootTree && 'bg-amber-500 text-black hover:bg-amber-400 focus-visible:ring-amber-400/35'
          )}
        >
          {isPending ? (
            <span className="flex items-center gap-2">
              <span className="h-4 w-4 rounded-full border-2 border-current/30 border-t-current animate-spin" />
              {t('signingIn')}
            </span>
          ) : (
            t('signIn')
          )}
        </Button>
      </form>
    </div>
  );
}
