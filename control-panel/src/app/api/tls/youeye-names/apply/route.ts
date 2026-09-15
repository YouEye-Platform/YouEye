/**
 * YouEye Names — post-setup apply
 *
 * POST /api/tls/youeye-names/apply — switch a RUNNING platform to a saved
 * YouEye Names lease: installs the bundle's install identity, then runs the
 * full server-URL reconfigure to `<name>.<zone>` with the bundled certificate.
 * Streams reconfigure progress via Server-Sent Events.
 *
 * Body: the names bundle JSON itself (as produced by `youeye names export`),
 * or `{ "bundle": { ... } }`.
 *
 * Used by `youeye names import <bundle>` when setup is already completed, and
 * by the Settings → Network → Domain "import a saved name" flow.
 */

import { NextRequest } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { reconfigure } from '@/lib/reconfigure';
import { applyBundleIdentity, parseNamesBundle, type NamesBundle } from '@/lib/youeye-names/bundle';
import { validateStoredIdentity } from '@/lib/youeye-names/identity';
import { writeNamesLifecycleState } from '@/lib/youeye-names/state';
import { tlsStorage } from '@/lib/acme/storage';
import { validateCertificateMaterial } from '@/lib/youeye-names/certificate';
import { getCurrentCertificate } from '@/lib/youeye-names/client';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return new Response('Unauthorized', { status: 401 });
  }
  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
    return new Response('Invalid CSRF token', { status: 403 });
  }

  let bundle: NamesBundle | null = null;
  try {
    bundle = parseNamesBundle(await request.json());
  } catch {
    bundle = null;
  }
  if (!bundle) {
    return new Response(JSON.stringify({ error: 'Not a valid YouEye Names bundle (expected name, identity and tls fields)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const newDomain = bundle.fqdn;
  const appliedBundle = bundle;

  const stream = new ReadableStream({
    async start(controller) {
      function send(data: unknown) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      try {
        // Use the validated imported authority in memory. The persistent
        // identity is replaced only after the complete reconfigure succeeds.
        const importedIdentity = validateStoredIdentity(appliedBundle.identity).identity;
        send({ step: 'identity_import', status: 'running', message: `Validating the saved identity for ${newDomain}...` });

        const result = await reconfigure(
          {
            domain: newDomain,
            tls: 'names-bundle',
            namesBundle: appliedBundle,
            namesIdentity: importedIdentity,
          },
          (event) => send(event),
        );

        await applyBundleIdentity(appliedBundle);
        const activeCertificate = await tlsStorage.getCert();
        if (!activeCertificate) throw new Error('Imported certificate state is missing after reconfigure.');
        const validatedCertificate = validateCertificateMaterial({
          certificateChain: activeCertificate.certPem,
          privateKeyPem: activeCertificate.keyPem,
          fqdn: newDomain,
        });
        const brokerCertificate = await getCurrentCertificate(appliedBundle.name, importedIdentity);
        const activatedAt = new Date().toISOString();
        await writeNamesLifecycleState({
          schemaVersion: 2,
          service: appliedBundle.service,
          name: appliedBundle.name,
          fqdn: newDomain,
          status: 'healthy',
          provisioning: null,
          termsVersion: appliedBundle.consent.termsVersion,
          certificateTransparencyAcceptedAt: appliedBundle.consent.certificateTransparencyAcceptedAt,
          certificate: {
            fingerprint: validatedCertificate.fingerprint,
            provider:
              brokerCertificate?.fingerprint === validatedCertificate.brokerFingerprint
                ? brokerCertificate.provider
                : appliedBundle.certificate.provider,
            issuedAt: validatedCertificate.issuedAt,
            expiresAt: validatedCertificate.expiresAt,
          },
          lastBrokerContactAt: activatedAt,
          lastHeartbeatAt: null,
          nextCheckAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
          lastError: null,
        });
        send({ step: 'identity_import', status: 'done', message: 'Saved name identity installed' });

        send({ complete: true, newUrl: result.newUrl });
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        send({ error: message });
        console.error('[names apply] failed:', err);
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
