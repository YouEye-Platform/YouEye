import { type NextRequest } from 'next/server';
import { handleMarketUpdate } from '@/lib/market/update-http';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  return handleMarketUpdate(req);
}
