/**
 * System Language Settings Card
 *
 * Allows admins to set the platform-wide default language.
 * Reads/writes via Spine API (youeye.yaml).
 */

'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Check, Loader2, Globe, AlertCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { authenticatedFetch } from '@/lib/api-client';

const LANGUAGES = [
  { code: 'en', native: 'English', english: 'English' },
  { code: 'ru', native: 'Русский', english: 'Russian' },
  { code: 'es', native: 'Español', english: 'Spanish' },
  { code: 'de', native: 'Deutsch', english: 'German' },
  { code: 'fr', native: 'Français', english: 'French' },
];

export function LanguageCard() {
  const t = useTranslations('settings.language');
  const tc = useTranslations('common');
  const [currentLang, setCurrentLang] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchLanguage() {
      try {
        const res = await authenticatedFetch('/api/setup/config');
        if (res.ok) {
          const data = await res.json();
          setCurrentLang(data.language || 'en');
        }
      } catch {
        setError('Failed to load current language');
      } finally {
        setLoading(false);
      }
    }
    fetchLanguage();
  }, []);

  const handleChange = async (code: string) => {
    if (code === currentLang) return;
    setSaving(true);
    setStatus('idle');
    setError(null);

    try {
      const res = await authenticatedFetch('/api/setup/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: code }),
      });

      if (res.ok) {
        setCurrentLang(code);
        setStatus('saved');
        // Fire-and-forget: sync language to Authentik user profile + apps
        fetch('/api/user/language', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locale: code }),
        }).catch(() => {});
        window.location.reload();
      } else {
        setStatus('error');
        setError(t('error'));
      }
    } catch {
      setStatus('error');
      setError(t('error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-5 w-5" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {tc('loading')}
          </div>
        ) : (
          <>
            {LANGUAGES.map((lang) => (
              <button
                key={lang.code}
                onClick={() => handleChange(lang.code)}
                disabled={saving}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border text-sm transition-colors cursor-pointer ${
                  currentLang === lang.code
                    ? 'border-primary bg-primary/5 text-foreground'
                    : 'border-border hover:border-border/80 text-muted-foreground hover:text-foreground'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="font-medium">{lang.native}</span>
                  {lang.native !== lang.english && (
                    <span className="text-muted-foreground">({lang.english})</span>
                  )}
                </div>
                {currentLang === lang.code && <Check className="w-4 h-4 text-primary" />}
              </button>
            ))}

            {status === 'saved' && (
              <p className="text-sm text-green-600 flex items-center gap-1">
                <Check className="h-3 w-3" />
                {t('saved')}
              </p>
            )}
            {error && (
              <p className="text-sm text-red-600 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {error}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
