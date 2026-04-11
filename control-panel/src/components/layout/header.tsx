'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { LogOut, User, Shield } from 'lucide-react';
import type { SessionPayload } from '@/types';

interface HeaderProps {
  session: SessionPayload;
  title?: string;
}

export function Header({ session, title }: HeaderProps) {
  const router = useRouter();
  const t = useTranslations('header');

  async function handleLogout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      localStorage.removeItem('csrfToken');
      router.push('/login');
      router.refresh();
    } catch (err) {
      console.error('Logout error:', err);
    }
  }

  return (
    <header className="h-16 bg-white border-b border-gray-200 px-6 flex items-center justify-between">
      <div>
        {title && <h2 className="text-lg font-semibold text-gray-900">{title}</h2>}
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 text-gray-600">
          {session.isAdmin ? (
            <Shield className="h-4 w-4 text-amber-500" />
          ) : (
            <User className="h-4 w-4" />
          )}
          <span className="text-sm font-medium">{session.username}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleLogout}
          className="text-gray-500 hover:text-gray-700"
        >
          <LogOut className="h-4 w-4 mr-2" />
          {t('logout')}
        </Button>
      </div>
    </header>
  );
}
