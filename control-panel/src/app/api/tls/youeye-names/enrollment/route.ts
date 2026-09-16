import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { spineClient } from '@/lib/spine/client';
import {
  createHumanVerificationChallenge,
  getNamesReadiness,
  namesErrorMessage,
  registerInstall,
} from '@/lib/youeye-names/client';

function privateIPv4(ip: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((value) => value > 255)) return false;
  const [first, second] = octets;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127);
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  try {
    if (body.action === 'register') {
      if (typeof body.humanVerificationProof !== 'string') {
        return NextResponse.json({ error: 'Verification proof missing' }, { status: 400 });
      }
      await registerInstall(body.humanVerificationProof);
      return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
    }
    if (body.action !== 'challenge' || !['install_register', 'lease_claim'].includes(String(body.purpose))) {
      return NextResponse.json({ error: 'Unsupported enrollment action' }, { status: 400 });
    }
    const readiness = await getNamesReadiness();
    if (!readiness.installation.canProceedNow) {
      return NextResponse.json({
        error: 'YouEye Names cannot start a new address right now. Try again later or choose another address option.',
        readiness,
      }, { status: 409, headers: { 'cache-control': 'no-store' } });
    }
    if (body.purpose === 'install_register') {
      const challenge = await createHumanVerificationChallenge('install_register');
      return NextResponse.json({ ok: true, challenge }, { headers: { 'cache-control': 'no-store' } });
    }
    if (typeof body.name !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(body.name)) {
      return NextResponse.json({ error: 'Select a valid YouEye Names address first.' }, { status: 400 });
    }
    const currentIp = (await spineClient.getMetrics()).primary_ip.trim();
    if (!privateIPv4(currentIp)) {
      return NextResponse.json({
        error: 'Could not determine this server’s private network address. Check its network connection and try again.',
      }, { status: 409 });
    }
    const challenge = await createHumanVerificationChallenge('lease_claim', {
      name: body.name,
      currentIp,
    });
    return NextResponse.json({ ok: true, challenge }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return NextResponse.json(
      { error: namesErrorMessage(error) },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }
}
