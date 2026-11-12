import { getBridgeToken } from '@/lib/admin/bridge-client';
import { markAppCredentialReady } from '@/lib/db/queries/app-service-credentials';
import { authorizeCredentialBridge, handleAppCredentialReadiness } from '@/lib/auth/app-credential-readiness';

export async function POST(request: Request, { params }: { params: Promise<{ appId: string }> }) {
  const { appId } = await params;
  return handleAppCredentialReadiness(request, appId,
    request => authorizeCredentialBridge(request, getBridgeToken()), markAppCredentialReady);
}
