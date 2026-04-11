import { NextRequest, NextResponse } from 'next/server';
import { spineClient } from '@/lib/spine/client';

// GET /api/updates - Check for available updates
export async function GET() {
  try {
    const updates = await spineClient.checkUpdates();
    return NextResponse.json(updates);
  } catch (error) {
    console.error('Failed to check updates:', error);
    return NextResponse.json(
      { error: 'Failed to check for updates' },
      { status: 500 }
    );
  }
}
