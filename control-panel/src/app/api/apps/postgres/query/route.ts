/**
 * PostgreSQL Query API
 *
 * POST /api/apps/postgres/query
 * Executes a read-only SQL query and returns results.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { queryReadOnly } from '@/lib/postgres/client';

const MAX_QUERY_LENGTH = 10000;
const MAX_ROWS = 1000;

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // CSRF protection
    const csrfToken = request.headers.get('X-CSRF-Token');
    if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
    }

    const body = await request.json();
    const { sql } = body;

    if (!sql || typeof sql !== 'string') {
      return NextResponse.json({ error: 'SQL query is required' }, { status: 400 });
    }

    if (sql.length > MAX_QUERY_LENGTH) {
      return NextResponse.json(
        { error: `Query too long (max ${MAX_QUERY_LENGTH} characters)` },
        { status: 400 }
      );
    }

    // Block dangerous statements at the API level (READ ONLY transaction also enforces this)
    const normalized = sql.trim().toUpperCase();
    const forbidden = ['DROP', 'DELETE', 'INSERT', 'UPDATE', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE', 'COPY'];
    for (const keyword of forbidden) {
      if (normalized.startsWith(keyword)) {
        return NextResponse.json(
          { error: `Write operations not allowed: ${keyword} statements are blocked` },
          { status: 403 }
        );
      }
    }

    const startTime = Date.now();
    const result = await queryReadOnly(sql);
    const duration = Date.now() - startTime;

    // Limit returned rows
    const rows = result.rows.slice(0, MAX_ROWS);
    const columns = result.columns.map((name) => ({ name }));

    return NextResponse.json({
      columns,
      rows,
      rowCount: result.rows.length,
      truncated: result.rows.length > MAX_ROWS,
      duration,
    });
  } catch (error) {
    console.error('Error executing query:', error);
    const message = error instanceof Error ? error.message : 'Query execution failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
