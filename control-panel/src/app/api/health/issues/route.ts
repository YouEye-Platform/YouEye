import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/rbac';
import { ignoreIssue, listIssues, runIssueRepair } from '@/lib/health/issues';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const includeResolved = request.nextUrl.searchParams.get('includeResolved') === 'true';
  const issues = await listIssues(includeResolved);
  return NextResponse.json({
    issues,
    summary: {
      open: issues.filter((issue) => issue.state === 'open').length,
      critical: issues.filter((issue) => issue.state === 'open' && issue.severity === 'critical').length,
      error: issues.filter((issue) => issue.state === 'open' && issue.severity === 'error').length,
      warning: issues.filter((issue) => issue.state === 'open' && issue.severity === 'warning').length,
      info: issues.filter((issue) => issue.state === 'open' && issue.severity === 'info').length,
    },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  if (!body?.id || !body?.action) {
    return NextResponse.json({ error: 'Missing id or action' }, { status: 400 });
  }

  if (body.action === 'ignore') {
    const issue = await ignoreIssue(String(body.id), String(body.reason ?? ''));
    return issue ? NextResponse.json({ issue }) : NextResponse.json({ error: 'Issue not found' }, { status: 404 });
  }

  if (body.action === 'fix') {
    const result = await runIssueRepair(String(body.id));
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
