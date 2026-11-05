/** Query durable deployment state after a progress-stream disconnect. */

import { NextRequest } from 'next/server';

import { getDeploymentJob } from '@/lib/infrastructure/deployment-jobs';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const secret = request.headers.get('X-Deploy-Secret');
  const expectedSecret = process.env.TEST_ADMIN_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { id } = await context.params;
    const job = await getDeploymentJob(id);
    if (!job) return Response.json({ error: 'Deployment job not found' }, { status: 404 });
    return Response.json(job, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : 'Could not read deployment job',
    }, { status: 400 });
  }
}
