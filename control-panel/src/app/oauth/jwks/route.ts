import { NextResponse } from 'next/server';
import { getOAuthJWKS } from '@/lib/identity/tokens';

export async function GET() {
  return NextResponse.json(await getOAuthJWKS());
}
