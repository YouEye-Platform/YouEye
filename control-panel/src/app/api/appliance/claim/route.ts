import { randomBytes, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  createSetupSession,
  generateCSRFToken,
  setSessionCookies,
} from '@/lib/auth';
import { requestClientAddress } from '@/lib/auth/client-address';
import { beginSignInAttempt, signInNotCounted, signInSucceeded } from '@/lib/identity/sign-in-limit';
import { isLocalSetupHost, secureCookieFor } from '@/lib/auth/mode';
import {
  claimApplianceOwner,
  getApplianceClaimStatus,
  reconcileApplianceSetupComplete,
  verifyApplianceOwner,
} from '@/lib/identity/store';
import { validateIdentityPassword } from '@/lib/identity/password-policy';
import { validateIdentityUsername } from '@/lib/identity/username-policy';

const CLAIM_CSRF_COOKIE = 'ye-claim-csrf';

function requestIsLocalAppliance(request: NextRequest): boolean {
  const host = request.headers.get('host') || '';
  if (!isLocalSetupHost(host)) return false;
  const origin = request.headers.get('origin');
  if (!origin) return request.method === 'GET';
  const protocol = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
    || request.nextUrl.protocol.replace(':', '');
  return origin === `${protocol}://${host}`;
}

function validCSRF(request: NextRequest): boolean {
  const header = request.headers.get('x-csrf-token') || '';
  const cookie = request.cookies.get(CLAIM_CSRF_COOKIE)?.value || '';
  if (!header || header.length !== cookie.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(cookie));
}

function validateAccount(input: Record<string, unknown>): string | null {
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const repeatPassword = typeof input.repeatPassword === 'string' ? input.repeatPassword : '';
  const firstName = typeof input.firstName === 'string' ? input.firstName.trim() : '';
  const lastName = typeof input.lastName === 'string' ? input.lastName.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const usernameError = validateIdentityUsername(username);
  if (usernameError) {
    return usernameError;
  }
  const passwordError = validateIdentityPassword(password);
  if (passwordError) return passwordError;
  if (password !== repeatPassword) return 'Passwords do not match.';
  if (!firstName || firstName.length > 100) return 'Enter your first name.';
  if (lastName.length > 100) return 'Last name must be 100 characters or fewer.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return 'Enter a valid email address.';
  }
  return null;
}

export async function GET(request: NextRequest) {
  if (!requestIsLocalAppliance(request)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  try {
    let status = await getApplianceClaimStatus();
    if (!status.setupCompleted) {
      const { settingsService } = await import('@/lib/settings');
      const config = await settingsService.getRaw().catch(() => null);
      if (config?.setup_completed) {
        await reconcileApplianceSetupComplete();
        status = await getApplianceClaimStatus();
      }
    }
    const csrfToken = randomBytes(32).toString('hex');
    const response = NextResponse.json({ ...status, csrfToken });
    response.cookies.set(CLAIM_CSRF_COOKIE, csrfToken, {
      httpOnly: true,
      secure: secureCookieFor(request),
      sameSite: 'strict',
      maxAge: 600,
      path: '/api/appliance/claim',
    });
    return response;
  } catch (error) {
    console.error('[appliance-claim] Claim state is not ready:', error instanceof Error ? error.message : 'unknown error');
    return NextResponse.json({ error: 'YouEye ID is still preparing. Try again shortly.' }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  if (!requestIsLocalAppliance(request)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (!validCSRF(request)) {
    return NextResponse.json({ error: 'The claim page expired. Reload and try again.' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json() as unknown;
    body = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return NextResponse.json({ error: 'The owner account could not be prepared. Try again.' }, { status: 400 });
  }
  const action = body.action === 'resume' ? 'resume' : 'claim';
  // Failures per username (resume checks the owner's password) from any address, and per client address (the TCP
  // peer; Caddy's X-Forwarded-For only from Caddy). Loopback and unknown are no client address (YE-136).
  const attempt = beginSignInAttempt(
    typeof body.username === 'string' ? body.username : '',
    await requestClientAddress(request.headers),
    'appliance-claim',
  );
  if (!attempt.allowed) {
    return NextResponse.json(
      { error: 'Too many attempts. Try again in a few minutes.' },
      { status: 429, headers: { 'Retry-After': String(Math.max(1, Math.ceil((attempt.retryAt - Date.now()) / 1000))) } }
    );
  }

  try {
    const status = await getApplianceClaimStatus();
    if (status.setupCompleted) {
      signInNotCounted(attempt);
      return NextResponse.json({ error: 'This appliance has already completed setup.' }, { status: 409 });
    }

    let user;
    if (action === 'claim') {
      const validationError = validateAccount(body);
      if (validationError) {
        signInNotCounted(attempt);
        return NextResponse.json({ error: validationError }, { status: 400 });
      }
      if (status.claimed) {
        signInNotCounted(attempt);
        return NextResponse.json({ error: 'This appliance has already been claimed. Sign in to resume setup.' }, { status: 409 });
      }
      user = await claimApplianceOwner({
		username: String(body.username).trim(),
		password: String(body.password),
		firstName: String(body.firstName).trim(),
		lastName: typeof body.lastName === 'string' ? body.lastName.trim() : '',
        email: String(body.email).trim(),
      });
      if (!user) {
        signInNotCounted(attempt);
        return NextResponse.json({ error: 'The owner account could not be claimed. Reload to see the current state.' }, { status: 409 });
      }
    } else {
      if (!status.claimed) {
        signInNotCounted(attempt);
        return NextResponse.json({ error: 'This appliance has not been claimed yet.' }, { status: 409 });
      }
		const username = typeof body.username === 'string' ? body.username.trim() : '';
		const password = typeof body.password === 'string' ? body.password : '';
		const passwordError = validateIdentityPassword(password);
		if (passwordError) {
        signInNotCounted(attempt);
        return NextResponse.json({ error: passwordError }, { status: 400 });
      }
      user = await verifyApplianceOwner(username, password);
      if (!user) return NextResponse.json({ error: 'Invalid YouEye ID credentials.', remaining: attempt.remaining }, { status: 401 });
    }

    signInSucceeded(attempt);
    const sessionToken = await createSetupSession({ ownerId: user.id, username: user.username });
    const csrfToken = generateCSRFToken();
    await setSessionCookies(sessionToken, csrfToken, { request, maxAge: 7200 });
    return NextResponse.json({ success: true, next: '/setup' });
  } catch (error) {
    console.error('[appliance-claim] Request failed:', error instanceof Error ? error.message : 'unknown error');
    signInNotCounted(attempt);
    return NextResponse.json({ error: 'The owner account could not be prepared. Try again.' }, { status: 500 });
  }
}
