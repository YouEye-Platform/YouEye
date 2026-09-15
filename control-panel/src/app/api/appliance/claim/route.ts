import { randomBytes, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  checkRateLimit,
  createSetupSession,
  generateCSRFToken,
  resetRateLimit,
  setSessionCookies,
} from '@/lib/auth';
import { isApplianceSetupHost } from '@/lib/auth/mode';
import {
  claimApplianceOwner,
  getApplianceClaimStatus,
  reconcileApplianceSetupComplete,
  verifyApplianceOwner,
} from '@/lib/identity/store';
import { validateIdentityPassword } from '@/lib/identity/password-policy';

const CLAIM_CSRF_COOKIE = 'ye-claim-csrf';
const MAX_ATTEMPTS = 10;
const WINDOW_SECONDS = 300;

function requestIP(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
}

function requestIsLocalAppliance(request: NextRequest): boolean {
  const host = request.headers.get('host') || '';
  if (!isApplianceSetupHost(host)) return false;
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
  if (!/^[a-z][a-z0-9._-]{2,31}$/.test(username)) {
    return 'Username must be 3-32 characters and start with a lowercase letter.';
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
      secure: request.headers.get('x-forwarded-proto') !== 'http',
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

  const ip = requestIP(request);
  const rateLimitKey = `appliance-claim:${ip}`;
  const limit = checkRateLimit(rateLimitKey, MAX_ATTEMPTS, WINDOW_SECONDS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many attempts. Try again in a few minutes.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((limit.resetAt - Date.now()) / 1000)) } }
    );
  }

  try {
    const body = await request.json() as Record<string, unknown>;
    const action = body.action === 'resume' ? 'resume' : 'claim';
    const status = await getApplianceClaimStatus();
    if (status.setupCompleted) {
      return NextResponse.json({ error: 'This appliance has already completed setup.' }, { status: 409 });
    }

    let user;
    if (action === 'claim') {
      const validationError = validateAccount(body);
      if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });
      if (status.claimed) {
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
        return NextResponse.json({ error: 'The owner account could not be claimed. Reload to see the current state.' }, { status: 409 });
      }
    } else {
      if (!status.claimed) return NextResponse.json({ error: 'This appliance has not been claimed yet.' }, { status: 409 });
		const username = typeof body.username === 'string' ? body.username.trim() : '';
		const password = typeof body.password === 'string' ? body.password : '';
		const passwordError = validateIdentityPassword(password);
		if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });
      user = await verifyApplianceOwner(username, password);
      if (!user) return NextResponse.json({ error: 'Invalid YouEye ID credentials.', remaining: limit.remaining }, { status: 401 });
    }

    resetRateLimit(rateLimitKey);
    const sessionToken = await createSetupSession({ ownerId: user.id, username: user.username });
    const csrfToken = generateCSRFToken();
    await setSessionCookies(sessionToken, csrfToken, { request });
    return NextResponse.json({ success: true, next: '/setup' });
  } catch (error) {
    console.error('[appliance-claim] Request failed:', error instanceof Error ? error.message : 'unknown error');
    return NextResponse.json({ error: 'The owner account could not be prepared. Try again.' }, { status: 500 });
  }
}
