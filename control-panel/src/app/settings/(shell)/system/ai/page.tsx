import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AISystemClient } from '@/components/settings-shell/ai-system-client';

export default async function AISystemPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect('/settings');
  return <AISystemClient />;
}
