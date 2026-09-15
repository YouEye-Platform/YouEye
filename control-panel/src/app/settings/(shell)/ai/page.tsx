import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AIClient } from '@/components/settings-shell/ai-client';

export default async function AISettingsPage() {
  const session = await getSession();
  if (!session || session.authMethod === 'pam' || session.authMethod === 'cli') redirect('/settings');
  return <AIClient section="models" />;
}
