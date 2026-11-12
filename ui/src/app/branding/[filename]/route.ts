import { BRANDING_DIR, persistentAssetResponse } from '@/lib/persistent-assets';

export const runtime = 'nodejs';
export async function GET(_request: Request, context: { params: Promise<{ filename: string }> }) {
  return persistentAssetResponse(BRANDING_DIR, [(await context.params).filename]);
}
