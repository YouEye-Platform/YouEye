/**
 * PostgreSQL Databases API
 *
 * GET /api/apps/postgres/databases
 * Returns list of databases with size and owner info.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { listDatabases } from '@/lib/postgres/client';

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const databases = await listDatabases();
    return NextResponse.json({ databases });
  } catch (error) {
    console.error('Error listing databases:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list databases' },
      { status: 500 }
    );
  }
}
