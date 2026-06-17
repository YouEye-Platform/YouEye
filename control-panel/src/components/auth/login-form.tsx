'use client';

import { useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { Server, Lock, User, AlertCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSiteConfig } from '@/hooks/use-site-config';
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
  const [username, setUsername] = useState('');
  const { site_name } = useSiteConfig();
  const t = useTranslations('login');
  const authBase = settingsFlow ? '/settings/api/auth' : '/api/auth';
  const showRootTree = username.trim() === 'root';

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
    <div className="relative flex w-full max-w-5xl justify-center px-4">
      <pre
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute left-1/2 top-[58%] hidden -translate-x-1/2 -translate-y-1/2 select-none font-mono text-[10px] leading-[0.9] tracking-normal text-foreground/25 transition-opacity duration-500 dark:text-foreground/30 sm:block',
          showRootTree ? 'opacity-100' : 'opacity-0'
        )}
      >
        {ROOT_TREE_ART.join('\n')}
      </pre>

      <Card className="relative z-10 w-full max-w-md border-border bg-card/95 text-card-foreground shadow-lg backdrop-blur-sm">
        <CardHeader className="space-y-1 text-center">
          <div className="flex justify-center mb-4">
            <div className="p-3 rounded-full bg-primary/10">
              <Server className="h-8 w-8 text-primary" />
            </div>
          </div>
          <CardTitle className="text-xl font-semibold">
            {showRootTree ? 'Local administrator' : `${site_name} ${t('controlPanel')}`}
          </CardTitle>
          <CardDescription>
            {t('signInDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={handleSubmit} className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  {error}
                  {remaining !== null && remaining > 0 && (
                    <span className="block mt-1 text-sm">
                      {remaining} attempt{remaining !== 1 ? 's' : ''} remaining
                    </span>
                  )}
                </AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="username">{t('username')}</Label>
              <div className="relative">
                <User className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  id="username"
                  name="username"
                  type="text"
                  placeholder="root"
                  autoComplete="username"
                  required
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  className="pl-10"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">{t('password')}</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  id="password"
                  name="password"
                  type="password"
                  placeholder="********"
                  autoComplete="current-password"
                  required
                  className="pl-10"
                />
              </div>
            </div>

            <Button type="submit" className="w-full" disabled={isPending}>
              {isPending ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                  {t('signingIn')}
                </span>
              ) : (
                t('signIn')
              )}
            </Button>
          </form>

          <div className="mt-6 pt-4 border-t border-border">
            <p className="text-xs text-muted-foreground text-center">
              {t('pamHint')}
              <br />
              {t('adminHint')}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
