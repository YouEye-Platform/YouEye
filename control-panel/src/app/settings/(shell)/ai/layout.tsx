import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { getUserById } from '@/lib/identity/store';
import { PointerConsole } from '@/components/settings-shell/pointer-console';

export default async function AISettingsLayout(_props: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session || session.authMethod === 'pam' || session.authMethod === 'cli') redirect('/settings');
  const user = await getUserById(session.identityId ?? "");
  if (!user?.is_active || user.id !== session.identityId) redirect('/settings/login');
  return <PointerConsole user={{ id: user.id, name: user.name || user.username, email: '', role: user.is_admin ? 'admin' : 'user' }} />;
}
