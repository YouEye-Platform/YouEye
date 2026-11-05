/**
 * Apps API
 * 
 * Returns the list of Spine-deployed apps.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getAppManifests } from '@/lib/apps/manifest';

export async function GET() {
  try {
    const session = await getSession();
    
    if (!session) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    return NextResponse.json({ apps: getAppManifests() });
  } catch (error) {
    console.error('Error fetching apps:', error);
    return NextResponse.json(
      { error: 'Failed to fetch apps' },
      { status: 500 }
    );
  }
}
