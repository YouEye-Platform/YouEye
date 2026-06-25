import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/auth/login-form';
import { getAuthModeForHost } from '@/lib/auth/mode';

interface LoginPageProps {
  searchParams: Promise<{ error?: string; redirect?: string }>;
}

function safeRelativeRedirect(value: string | undefined, fallback: string): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return fallback;
  return value;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const headerStore = await headers();
  const host = headerStore.get('host') || '';
  const params = await searchParams;

  if (getAuthModeForHost(host) === 'sso') {
    const returnTo = safeRelativeRedirect(params.redirect, '/');
    redirect(`/api/auth/sso?redirect=${encodeURIComponent(returnTo)}`);
  }

  return <LoginForm initialError={params.error ?? null} />;
}
