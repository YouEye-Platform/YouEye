/** Durable, reconnectable infrastructure reconciliation endpoint. */

import { NextRequest } from 'next/server';

import { reconcileInfrastructure } from '@/lib/infrastructure/deployer';
import {
  createDeploymentJobStream,
  newDeploymentID,
  startDeploymentJob,
  validateDeploymentID,
} from '@/lib/infrastructure/deployment-jobs';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const secret = request.headers.get('X-Deploy-Secret');
  const expectedSecret = process.env.TEST_ADMIN_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let hostIP: string;
  let deploymentID: string;
  try {
    const body = await request.json();
    hostIP = String(body.host_ip || '').trim();
    deploymentID = validateDeploymentID(
      String(body.deployment_id || newDeploymentID('reconcile')),
    );
    if (!hostIP) throw new Error('missing host_ip');
  } catch (error) {
    return Response.json({
      error: 'Invalid body — expected { "host_ip": "...", "deployment_id": "..." }',
      detail: error instanceof Error ? error.message : undefined,
    }, { status: 400 });
  }

  try {
    await startDeploymentJob({
      id: deploymentID,
      kind: 'reconcile',
      hostIP,
      runner: reconcileInfrastructure,
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : 'Could not start reconciliation job',
    }, { status: 409 });
  }

  return new Response(createDeploymentJobStream(deploymentID), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-YouEye-Deployment-ID': deploymentID,
    },
  });
}
