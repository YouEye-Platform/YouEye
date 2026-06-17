import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/auth/login-form';
import { getAuthModeForHost } from '@/lib/auth/mode';

interface SettingsLoginPageProps {
  searchParams: Promise<{ error?: string; redirect?: string }>;
}

function safeRelativeRedirect(value: string | undefined, fallback: string): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return fallback;
  return value;
}

export default async function SettingsLoginPage({ searchParams }: SettingsLoginPageProps) {
  const headerStore = await headers();
  const host = headerStore.get('host') || '';
  const params = await searchParams;

  if (getAuthModeForHost(host) === 'sso') {
    const returnTo = safeRelativeRedirect(params.redirect, '/settings');
    redirect(`/settings/api/auth/sso?redirect=${encodeURIComponent(returnTo)}`);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <LoginForm initialError={params.error ?? null} settingsFlow />
    </div>
  );
}
