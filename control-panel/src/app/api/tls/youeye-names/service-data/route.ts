import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { exportInstallData, namesErrorMessage } from '@/lib/youeye-names/client';
import { readNamesLifecycleState } from '@/lib/youeye-names/state';

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }
  const state = await readNamesLifecycleState();
  if (!state) return NextResponse.json({ error: 'YouEye Names is not active.' }, { status: 404 });
  try {
    const data = await exportInstallData(state.name);
    return new NextResponse(JSON.stringify(data, null, 2), {
      headers: {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="youeye-names-${state.name}-service-data.json"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return NextResponse.json({ error: namesErrorMessage(error) }, { status: 503 });
  }
}
