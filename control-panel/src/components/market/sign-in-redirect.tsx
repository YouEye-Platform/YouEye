'use client';

import { useEffect, useState } from 'react';
import { useTranslations as useInterfaceTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { marketSignInStep, SIGN_IN_ATTEMPT_KEY, signInAttempt, type SignInStep } from './sign-in-location';

function storedAttempt(): string | null | undefined {
  try { return window.sessionStorage.getItem(SIGN_IN_ATTEMPT_KEY); } catch { return undefined; }
}

function rememberAttempt(value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(SIGN_IN_ATTEMPT_KEY);
    else window.sessionStorage.setItem(SIGN_IN_ATTEMPT_KEY, value);
  } catch { /* storage unavailable: the owner signs in with the link */ }
}

/**
 * The Market shell's sign-in redirect: only the browser knows the page's full address (a layout does not). It
 * redirects once; a page that comes back from that sign-in still signed out shows a sign-in link instead of
 * redirecting again (`marketSignInStep`).
 */
export function SignInRedirect({ sso }: { sso: boolean }) {
  const translateInterface = useInterfaceTranslations('interface');
  const [step, setStep] = useState<SignInStep | null>(null);

  useEffect(() => {
    const next = marketSignInStep(sso, window.location.pathname, window.location.search, storedAttempt(), Date.now());
    if (next.kind === 'redirect') {
      rememberAttempt(next.attempt);
      window.location.replace(next.location);
      return;
    }
    // Shown, not followed: a click starts a fresh attempt (remembered again, so a second failure stops here too).
    rememberAttempt(null);
    setStep(next);
  }, [sso]);

  if (!step || step.kind === 'redirect') {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-7 w-7 animate-spin text-primary" />
      </div>
    );
  }
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-3 px-6 text-center">
      {step.reason === 'too-long' && (
        <p className="max-w-md text-sm text-muted-foreground">{translateInterface('m29c4a2d2ca6c')}</p>
      )}
      <a
        href={step.location}
        onClick={() => rememberAttempt(signInAttempt(`${window.location.pathname}${window.location.search}`, Date.now()))}
        className="text-sm font-medium text-primary hover:underline"
      >
        {translateInterface('m607a80121c65')}
      </a>
    </div>
  );
}
