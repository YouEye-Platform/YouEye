'use client';

import { useTranslations as useInterfaceTranslations } from "next-intl";
import { FormEvent, useState } from 'react';
import { AlertCircle, KeyRound, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { IDENTITY_PASSWORD_MAX_LENGTH, IDENTITY_PASSWORD_MIN_LENGTH } from '@/lib/identity/password-policy';

/** Public page: the owner sets a new YouEye ID password with the code the box's console shows. */
export function OwnerResetForm() {
  const translateInterface = useInterfaceTranslations("interface");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function message(code: string | undefined): string {
    switch (code) {
      case 'invalid_code': return translateInterface("mc4cbb58961e7");
      case 'password_mismatch': return translateInterface("mb6eb82cd3300");
      case 'invalid_password': return translateInterface("m0c819f896984");
      case 'rate_limited': return translateInterface("m52eb86aa5050");
      default: return translateInterface("m4b9ac6f2fac5");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    if (form.get('password') !== form.get('repeatPassword')) {
      setError(message('password_mismatch'));
      return;
    }
    setSubmitting(true);
    const response = await fetch('/settings/api/auth/reset-owner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: form.get('code'), password: form.get('password'), repeatPassword: form.get('repeatPassword') }),
    }).catch(() => null);
    const body = response ? await response.json().catch(() => ({})) : {};
    setSubmitting(false);
    if (!response?.ok) {
      setError(message(body.code));
      return;
    }
    setDone(true);
  }

  return (
    <main className="flex min-h-screen w-full items-center justify-center px-6 py-10">
      <form onSubmit={submit} className="w-full max-w-[420px] space-y-5 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-2 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <KeyRound className="h-5 w-5" />
          </div>
          <h1 className="text-xl font-semibold">{translateInterface("med9189635d8d")}</h1>
          <p className="text-sm text-muted-foreground">
            {done
              ? translateInterface("m1b7ff86ef96b")
              : translateInterface("meeb2dfbd7dec")}
          </p>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {done ? (
          <Button type="button" className="w-full" onClick={() => window.location.assign('/settings')}>{translateInterface("mbfd402b2f6f3")}</Button>
        ) : (
          <>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="code">{translateInterface("m1df15fd319a1")}</Label>
                <Input id="code" name="code" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} maxLength={64} required autoFocus />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">{translateInterface("m3dd9df4441fb")}</Label>
                <Input id="password" name="password" type="password" autoComplete="new-password"
                  minLength={IDENTITY_PASSWORD_MIN_LENGTH} maxLength={IDENTITY_PASSWORD_MAX_LENGTH} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="repeatPassword">{translateInterface("mb74070f90e8c")}</Label>
                <Input id="repeatPassword" name="repeatPassword" type="password" autoComplete="new-password"
                  minLength={IDENTITY_PASSWORD_MIN_LENGTH} maxLength={IDENTITY_PASSWORD_MAX_LENGTH} required />
              </div>
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}{translateInterface("me0edfeb3a71a")}</Button>
          </>
        )}
      </form>
    </main>
  );
}
