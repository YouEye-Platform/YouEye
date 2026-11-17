import { setTimeout as delay } from 'node:timers/promises';
import { controlPanelVersion } from '@/lib/build-version';
import { withIndependentCopyExclusion } from '@/lib/market/update-admission';
import { tlsStorage } from '@/lib/acme/storage';
import * as caddy from '@/lib/caddy/client';
import { spineClient } from '@/lib/spine/client';
import { settingsService } from '@/lib/settings';
import {
  getCertificateTerms,
  getCurrentCertificate,
  heartbeat,
  NamesBrokerError,
  requestCertificate,
} from './client';
import { sameCertificateInstant, validateCertificateMaterial } from './certificate';
import { generateCsr } from './csr';
import {
  readNamesLifecycleState,
  updateNamesLifecycleState,
  writeNamesLifecycleState,
} from './state';
import { followNamesJob, markNamesFailure } from './provision';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
let loopStarted = false;
let checkInFlight: Promise<void> | null = null;

async function waitForCertificate(name: string) {
  const deadline = Date.now() + 10 * 60_000;
  let pollDelay = 2_000;
  while (Date.now() < deadline) {
    const certificate = await getCurrentCertificate(name);
    if (certificate) return certificate;
    await delay(pollDelay);
    pollDelay = Math.min(10_000, Math.round(pollDelay * 1.5));
  }
  throw new Error('certificate_not_ready_before_renewal_deadline');
}

/** Run one lease heartbeat and, when due, an atomic certificate replacement. */
export async function runNamesMaintenance(): Promise<void> {
  if (checkInFlight) return checkInFlight;
  checkInFlight = withIndependentCopyExclusion(async () => {
    const state = await readNamesLifecycleState();
    if (!state || state.status === 'released') return;

    try {
      if (state.status === 'provisioning') {
        await followNamesJob();
        return;
      }
      if (!state.certificate) throw new Error('youeye_names_certificate_state_missing');
      const stored = await tlsStorage.getCert();
      if (!stored || !stored.domains.includes(state.fqdn)) {
        throw new Error('youeye_names_active_certificate_missing');
      }
      const activeCertificate = validateCertificateMaterial({
        certificateChain: stored.certPem,
        privateKeyPem: stored.keyPem,
        fqdn: state.fqdn,
        allowExpired: true,
      });
      if (
        activeCertificate.fingerprint !== state.certificate.fingerprint ||
        !sameCertificateInstant(activeCertificate.expiresAt, state.certificate.expiresAt)
      ) {
        throw new Error('youeye_names_active_certificate_state_mismatch');
      }
      const now = new Date();
      const metrics = await spineClient.getMetrics();
      const renewalNeeded = Date.parse(stored.expiresAt) - now.getTime() <= RENEW_BEFORE_MS;
      const caddyHealthy = await caddy.checkHealth();
      const heartbeatResult = await heartbeat(state.name, {
        currentIp: metrics.primary_ip,
        certificateFingerprint: activeCertificate.brokerFingerprint,
        certificateExpiresAt: state.certificate.expiresAt,
        youeyeVersion: controlPanelVersion() === 'development' ? undefined : controlPanelVersion(),
        caddyStatus: caddyHealthy ? 'healthy' : 'unavailable',
        renewalNeeded,
      });
      const contactedAt = new Date().toISOString();
      await writeNamesLifecycleState({
        ...state,
        status: state.status === 'attention' ? 'healthy' : state.status,
        lastBrokerContactAt: contactedAt,
        lastHeartbeatAt: contactedAt,
        nextCheckAt: new Date(Date.now() + CHECK_INTERVAL_MS).toISOString(),
        lastError: null,
      });

      if (!renewalNeeded && !heartbeatResult.csrRequired) return;
      const terms = await getCertificateTerms();
      if (!state.termsVersion || state.termsVersion !== terms.version) {
        throw new NamesBrokerError({
          status: 409,
          code: 'certificate_terms_version_required',
        });
      }

      await updateNamesLifecycleState((current) => ({ ...current, status: 'renewing' }));
      const generated = await generateCsr(state.fqdn);
      await requestCertificate(state.name, generated.csrPem, terms.version, true);
      const issued = await waitForCertificate(state.name);
      const validated = validateCertificateMaterial({
        certificateChain: issued.certificateChain,
        privateKeyPem: generated.keyPem,
        fqdn: state.fqdn,
      });
      if (
        validated.brokerFingerprint !== issued.fingerprint ||
        !sameCertificateInstant(validated.expiresAt, issued.expiresAt)
      ) {
        throw new Error('youeye_names_certificate_metadata_mismatch');
      }

      await caddy.loadExternalCert(
        validated.certificateChain,
        generated.keyPem,
        [...validated.domains],
      );
      try {
        await tlsStorage.storeCert({
          mode: 'manual',
          certPem: validated.certificateChain,
          keyPem: generated.keyPem,
          issuer: 'YouEye Names',
          domains: [...validated.domains],
          expiresAt: validated.expiresAt,
          issuedAt: validated.issuedAt,
        });
      } catch (error) {
        await caddy
          .loadExternalCert(stored.certPem, stored.keyPem, stored.domains)
          .catch(() => undefined);
        throw error;
      }
      await updateNamesLifecycleState((current) => ({
        ...current,
        status: 'healthy',
        certificate: {
          fingerprint: validated.fingerprint,
          provider: issued.provider,
          issuedAt: validated.issuedAt,
          expiresAt: validated.expiresAt,
        },
        lastBrokerContactAt: new Date().toISOString(),
        nextCheckAt: new Date(Date.now() + CHECK_INTERVAL_MS).toISOString(),
        lastError: null,
      }));
    } catch (error) {
      await markNamesFailure(error);
      throw error;
    }
  });
  try {
    await checkInFlight;
  } finally {
    checkInFlight = null;
  }
}

/**
 * A Names job interrupted by a restart during setup resumes at once (same key,
 * CSR and request) instead of after the first maintenance delay.
 */
export async function resumeNamesJobAtStart(): Promise<boolean> {
  const state = await readNamesLifecycleState();
  if (state?.status !== 'provisioning') return false;
  if ((await settingsService.getRaw()).setup_completed === true) return false;
  await followNamesJob();
  return true;
}

export function startNamesMaintenanceLoop(): void {
  if (loopStarted || process.env.YOUEYE_NAMES_MAINTENANCE_ENABLED === 'false') return;
  loopStarted = true;
  void resumeNamesJobAtStart().catch((error) => {
    console.error('[youeye-names/maintenance] resuming the setup certificate failed:', error instanceof Error ? error.message : 'unknown');
  });
  const initialDelay = 90_000 + Math.floor(Math.random() * 60_000);
  setTimeout(() => {
    void runNamesMaintenance().catch((error) => {
      console.error('[youeye-names/maintenance] initial check failed:', error instanceof Error ? error.message : 'unknown');
    });
  }, initialDelay);
  setInterval(() => {
    void runNamesMaintenance().catch((error) => {
      console.error('[youeye-names/maintenance] check failed:', error instanceof Error ? error.message : 'unknown');
    });
  }, CHECK_INTERVAL_MS);
}
