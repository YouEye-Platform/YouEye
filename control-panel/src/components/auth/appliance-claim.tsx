'use client';

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
  const [state, setState] = useState<ClaimState | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/appliance/claim', { cache: 'no-store' })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'YouEye ID is unavailable.');
        setState(body);
      })
      .catch(reason => setError(reason instanceof Error ? reason.message : 'YouEye ID is unavailable.'))
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
      setError('Could not reach the appliance. Try again.');
      setSubmitting(false);
      return;
    }
    const body = await response.json();
    if (!response.ok) {
      setError(body.error || 'Could not continue setup.');
      setSubmitting(false);
      if (response.status === 409) window.location.reload();
      return;
    }
    window.location.assign(body.next || '/setup');
  }

  if (loading) {
    return (
      <main className="flex min-h-screen w-full items-center justify-center px-6 py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Preparing YouEye ID" />
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
        <h1 className="text-xl font-semibold">{state?.claimed ? 'Resume server setup' : 'Create your YouEye ID'}</h1>
        <p className="text-sm text-muted-foreground">
          {state?.claimed
            ? `Sign in as ${state.ownerUsername || 'the appliance owner'} to continue.`
            : 'This account becomes the first owner of this server.'}
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
              <Label htmlFor="firstName">First name</Label>
              <Input id="firstName" name="firstName" autoComplete="given-name" maxLength={100} required autoFocus />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lastName">Last name <span className="text-muted-foreground">(optional)</span></Label>
              <Input id="lastName" name="lastName" autoComplete="family-name" maxLength={100} />
            </div>
          </>
        )}
        <div className="space-y-2">
          <Label htmlFor="username">Username</Label>
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
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" maxLength={254} required />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
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
            <Label htmlFor="repeatPassword">Repeat password</Label>
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
        {state?.claimed ? 'Continue setup' : 'Create owner account'}
      </Button>
      {state?.operationActive && (
        <p className="text-center text-xs text-muted-foreground">Another browser is currently applying setup changes.</p>
      )}
    </form>
    </main>
  );
}
