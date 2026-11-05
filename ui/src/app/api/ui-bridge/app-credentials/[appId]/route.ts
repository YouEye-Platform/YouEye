import { getBridgeToken } from '@/lib/admin/bridge-client';
import { handleAppCredentialPublication } from '@/lib/auth/app-credential-publication';
import { publishAppServiceCredential, publishAppServiceCredentialBatch } from '@/lib/db/queries/app-service-credentials';
import { authorizeCredentialBridge } from '@/lib/auth/app-credential-readiness';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ appId: string }> },
): Promise<Response> {
  const { appId } = await params;
  return handleAppCredentialPublication(request, appId, {
    authorizeBridge: request => authorizeCredentialBridge(request, getBridgeToken()),
    publish: publishAppServiceCredential,
    publishBatch: publishAppServiceCredentialBatch,
  });
}
