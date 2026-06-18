'use client';

import { useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Server, Lock, User, AlertCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSiteConfig } from '@/hooks/use-site-config';

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
  const { site_name } = useSiteConfig();
  const t = useTranslations('login');
  const authBase = settingsFlow ? '/settings/api/auth' : '/api/auth';

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
    <Card className="w-full max-w-md bg-white border-gray-200 shadow-lg">
      <CardHeader className="space-y-1 text-center">
        <div className="flex justify-center mb-4">
          <div className="p-3 bg-blue-100 rounded-full">
            <Server className="h-8 w-8 text-blue-600" />
          </div>
        </div>
        <CardTitle className="text-2xl font-bold text-gray-900">
          {site_name} {t('controlPanel')}
        </CardTitle>
        <CardDescription className="text-gray-500">
          {t('signInDescription')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={handleSubmit} className="space-y-4">
          {error && (
            <Alert variant="destructive" className="bg-red-50 border-red-200">
              <AlertCircle className="h-4 w-4 text-red-600" />
              <AlertDescription className="text-red-700">
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
            <Label htmlFor="username" className="text-gray-700">{t('username')}</Label>
            <div className="relative">
              <User className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
              <Input
                id="username"
                name="username"
                type="text"
                placeholder="root"
                autoComplete="username"
                required
                className="pl-10 bg-white border-gray-300 text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="password" className="text-gray-700">{t('password')}</Label>
            <div className="relative">
              <Lock className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
              <Input
                id="password"
                name="password"
                type="password"
                placeholder="********"
                autoComplete="current-password"
                required
                className="pl-10 bg-white border-gray-300 text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:ring-blue-500"
              />
            </div>
          </div>

          <Button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white" disabled={isPending}>
            {isPending ? (
              <span className="flex items-center gap-2">
                <span className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                {t('signingIn')}
              </span>
            ) : (
              t('signIn')
            )}
          </Button>
        </form>

        <div className="mt-6 pt-4 border-t border-gray-200">
          <p className="text-xs text-gray-500 text-center">
            {t('pamHint')}
            <br />
            {t('adminHint')}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
