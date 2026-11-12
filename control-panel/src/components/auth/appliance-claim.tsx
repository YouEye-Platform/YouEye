'use client';




import { useTranslations as useInterfaceTranslations } from "next-intl";
import { FormEvent, useEffect, useState } from 'react';
import { AlertCircle, Loader2, UserRound } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { IDENTITY_PASSWORD_MAX_LENGTH, IDENTITY_PASSWORD_MIN_LENGTH } from '@/lib/identity/password-policy';

type ClaimState = {
  claimed: boolean;
  ownerUsername: string | null;
  operationActive: boolean;
  csrfToken: string;
};

export function ApplianceClaim() {
  const translateInterface = useInterfaceTranslations("interface");

  const [state, setState] = useState<ClaimState | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/appliance/claim', { cache: 'no-store' })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || translateInterface("m781199706a50"));
        setState(body);
      })
      .catch(reason => setError(translateInterface("m781199706a50")))
      .finally(() => setLoading(false));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state) return;
    setError(null);
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    const response = await fetch('/api/appliance/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken },
      body: JSON.stringify({
        action: state.claimed ? 'resume' : 'claim',
        username: form.get('username'),
        password: form.get('password'),
        repeatPassword: form.get('repeatPassword'),
        firstName: form.get('firstName'),
        lastName: form.get('lastName'),
        email: form.get('email'),
      }),
    }).catch(() => null);
    if (!response) {
      setError(translateInterface("macb428772ef9"));
      setSubmitting(false);
      return;
    }
    const body = await response.json();
    if (!response.ok) {
      setError(body.error || translateInterface("mebd15d646165"));
      setSubmitting(false);
      if (response.status === 409) window.location.reload();
      return;
    }
    window.location.assign(body.next || '/setup');
  }

  if (loading) {
    return (
      <main className="flex min-h-screen w-full items-center justify-center px-6 py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label={translateInterface("m99dffbe6bc08")} />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen w-full items-center justify-center px-6 py-10">
    <form onSubmit={submit} className="w-full max-w-[420px] space-y-5 rounded-lg border bg-card p-6 shadow-sm">
      <div className="space-y-2 text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <UserRound className="h-5 w-5" />
        </div>
        <h1 className="text-xl font-semibold">{state?.claimed ? translateInterface("m28e14d5f8603") : translateInterface("m299765892600")}</h1>
        <p className="text-sm text-muted-foreground">
          {state?.claimed
            ? translateInterface("m2187e7ff2743", { value0: String(state.ownerUsername || translateInterface("m3bdb6567b498")) })
            : translateInterface("mc595401544ae")}
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-4">
        {!state?.claimed && (
          <>
            <div className="space-y-2">
              <Label htmlFor="firstName">{translateInterface("m702ef921ed1d")}</Label>
              <Input id="firstName" name="firstName" autoComplete="given-name" maxLength={100} required autoFocus />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lastName">{translateInterface("m7b4888049459")}{" "}<span className="text-muted-foreground">{translateInterface("m0059798b7f70")}</span></Label>
              <Input id="lastName" name="lastName" autoComplete="family-name" maxLength={100} />
            </div>
          </>
        )}
        <div className="space-y-2">
          <Label htmlFor="username">{translateInterface("me3b89e9d33f8")}</Label>
          <Input
            id="username"
            name="username"
            autoComplete="username"
            defaultValue={state?.ownerUsername || ''}
            pattern="[a-z][a-z0-9._-]{2,31}"
            required
            autoFocus={Boolean(state?.claimed)}
          />
        </div>
        {!state?.claimed && (
          <div className="space-y-2">
            <Label htmlFor="email">{translateInterface("m969ccbd3cf63")}</Label>
            <Input id="email" name="email" type="email" autoComplete="email" maxLength={254} required />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="password">{translateInterface("me7cf3ef4f17c")}</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete={state?.claimed ? 'current-password' : 'new-password'}
            minLength={IDENTITY_PASSWORD_MIN_LENGTH}
            maxLength={IDENTITY_PASSWORD_MAX_LENGTH}
            required
          />
        </div>
        {!state?.claimed && (
          <div className="space-y-2">
            <Label htmlFor="repeatPassword">{translateInterface("mb74070f90e8c")}</Label>
            <Input
              id="repeatPassword"
              name="repeatPassword"
              type="password"
              autoComplete="new-password"
              minLength={IDENTITY_PASSWORD_MIN_LENGTH}
              maxLength={IDENTITY_PASSWORD_MAX_LENGTH}
              required
            />
          </div>
        )}
      </div>

      <Button type="submit" className="w-full" disabled={submitting || !state}>
        {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
        {state?.claimed ? translateInterface("mc5702c19da53") : translateInterface("m75d8201c860a")}
      </Button>
      {state?.operationActive && (
        <p className="text-center text-xs text-muted-foreground">{translateInterface("m1b3650fe2b8f")}</p>
      )}
    </form>
    </main>
  );
}
