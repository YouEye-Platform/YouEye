export const verifiedSetupProtocol = 'youeye-names.verified-setup' as const;
export type VerifiedSetupChallenge = {
  purpose: 'verified_setup'; serviceOrigin: string; enrollmentUrl: string;
  embeddedEnrollmentUrl: string; context: string; cdata: string; publicKey: string;
  installFingerprint: string; expiresAt: string; name: string; currentIp: string;
  parentOrigin: string; sessionId: string;
};
export type VerifiedSetupResult = {
  protocol: typeof verifiedSetupProtocol; v: 1; type: 'result'; sessionId: string;
  setupSession: string; expiresAt: string;
  binding: { installFingerprint: string; name: string; currentIp: string };
};
export function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual=Object.keys(value).sort(), expected=[...keys].sort();
  return actual.length===expected.length && actual.every((key,index)=>key===expected[index]);
}
export function validVerifiedSetupChallenge(value: VerifiedSetupChallenge, parentOrigin: string, sessionId: string): boolean {
  try {
    const origin=new URL(value.serviceOrigin), frame=new URL(value.embeddedEnrollmentUrl), standalone=new URL(value.enrollmentUrl);
    const expiry=Date.parse(value.expiresAt);
    return value.purpose==='verified_setup' && origin.protocol==='https:' && origin.origin===value.serviceOrigin &&
      !origin.username && !origin.password && origin.pathname==='/' && !origin.search && !origin.hash &&
      frame.origin===origin.origin && !frame.username && !frame.password && frame.pathname==='/enroll/embedded' && !frame.hash &&
      standalone.origin===origin.origin && !standalone.username && !standalone.password && standalone.pathname==='/enroll/setup' &&
      Boolean(frame.searchParams.get('admission')) && frame.search===standalone.search &&
      value.parentOrigin===parentOrigin && value.sessionId===sessionId && /^[A-Za-z0-9_-]{22,128}$/.test(sessionId) &&
      /^[A-Za-z0-9_-]{43}$/.test(value.publicKey) && /^[A-Za-z0-9_-]{43}$/.test(value.installFingerprint) &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.name) && typeof value.currentIp==='string' && value.currentIp.length<=64 &&
      typeof value.context==='string' && value.context.length>=20 && value.context.length<=4096 && /^[A-Za-z0-9_-]{1,64}$/.test(value.cdata) &&
      Number.isFinite(expiry) && expiry>Date.now() && expiry<=Date.now()+300000;
  } catch { return false; }
}
export function parseVerifiedSetupResult(value: unknown, challenge: VerifiedSetupChallenge): VerifiedSetupResult | null {
  if (!value || typeof value!=='object' || Array.isArray(value)) return null;
  const message=value as Record<string,unknown>;
  if (!exactKeys(message,['protocol','v','type','sessionId','setupSession','expiresAt','binding']) || message.protocol!==verifiedSetupProtocol || message.v!==1 || message.type!=='result' || message.sessionId!==challenge.sessionId || typeof message.setupSession!=='string' || message.setupSession.length>8192 || !message.setupSession.startsWith(challenge.context+'.') || !/^[A-Za-z0-9_-]{43}$/.test(message.setupSession.slice(challenge.context.length+1)) || typeof message.expiresAt!=='string') return null;
  const expiry=Date.parse(message.expiresAt);
  if (!Number.isFinite(expiry) || expiry<=Date.now() || expiry>Date.parse(challenge.expiresAt) || Date.parse(challenge.expiresAt)<=Date.now()) return null;
  if (!message.binding || typeof message.binding!=='object' || Array.isArray(message.binding)) return null;
  const binding=message.binding as Record<string,unknown>;
  if (!exactKeys(binding,['installFingerprint','name','currentIp']) || binding.installFingerprint!==challenge.installFingerprint || binding.name!==challenge.name || binding.currentIp!==challenge.currentIp) return null;
  return value as VerifiedSetupResult;
}
