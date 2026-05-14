'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Server,
  Globe,
  Package,
  Shield,
  Users,
  Settings,
  Store,
  HeartPulse,
} from 'lucide-react';

/** Sidebar navigation items — labels come from the "sidebar" translation namespace */
const navItems = [
  { href: '/', labelKey: 'dashboard' as const, icon: LayoutDashboard },
  { href: '/health', labelKey: 'health' as const, icon: HeartPulse },
  { href: '/apps', labelKey: 'apps' as const, icon: Package },
  { href: '/market', labelKey: 'appMarket' as const, icon: Store },
  { href: '/proxy', labelKey: 'reverseProxy' as const, icon: Globe },
  { href: '/dns', labelKey: 'dns' as const, icon: Shield },
  { href: '/people', labelKey: 'people' as const, icon: Users },
  { href: '/settings', labelKey: 'settings' as const, icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const t = useTranslations('sidebar');

  return (
    <aside className="w-64 bg-white border-r border-gray-200 min-h-screen flex flex-col">
      {/* Logo */}
      <div className="p-6 border-b border-gray-200">
        <Link href="/" className="flex items-center gap-3">
          <div className="p-2 bg-blue-100 rounded-lg">
            <Server className="h-6 w-6 text-blue-600" />
          </div>
          <div>
            <h1 className="font-bold text-gray-900">{t('youeye')}</h1>
            <p className="text-xs text-gray-500">{t('controlPanel')}</p>
          </div>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4">
        <ul className="space-y-1">
          {navItems.map((item) => {
            const isActive = pathname === item.href ||
              (item.href !== '/' && pathname.startsWith(item.href));
            const Icon = item.icon;

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                  )}
                >
                  <Icon className="h-5 w-5" />
                  {t(item.labelKey)}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-gray-200">
        <p className="text-xs text-gray-400 text-center">
          YouEye {t('controlPanel')}
        </p>
      </div>
    </aside>
  );
}
