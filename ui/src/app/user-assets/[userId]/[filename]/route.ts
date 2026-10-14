import { USER_ASSET_DIR, persistentAssetResponse } from '@/lib/persistent-assets';

export const runtime = 'nodejs';
export async function GET(_request: Request, context: { params: Promise<{ userId: string; filename: string }> }) {
  const { userId, filename } = await context.params;
  return persistentAssetResponse(USER_ASSET_DIR, [userId, filename]);
}
