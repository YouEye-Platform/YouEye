/**
 * Durable infrastructure deployment endpoint.
 *
 * The deployment job is independent of this request's progress stream. Spine
 * supplies a stable deployment_id, so it can query the job after any EOF and
 * retry the POST without starting a duplicate mutation.
 */

import { NextRequest } from 'next/server';

import { deployInfrastructure } from '@/lib/infrastructure/deployer';
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
      String(body.deployment_id || newDeploymentID('deploy')),
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
      kind: 'deploy',
      hostIP,
      runner: deployInfrastructure,
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : 'Could not start deployment job',
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
