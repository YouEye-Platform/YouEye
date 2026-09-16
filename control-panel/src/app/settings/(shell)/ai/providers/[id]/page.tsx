import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AIDetailClient } from '@/components/settings-shell/ai-detail-client';

export default async function AIProviderPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.authMethod === 'pam' || session.authMethod === 'cli') redirect('/settings');
  return <AIDetailClient kind="provider" id={(await params).id} />;
}
