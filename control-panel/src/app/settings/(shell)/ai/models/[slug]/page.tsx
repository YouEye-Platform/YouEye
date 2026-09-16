import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AIDetailClient } from '@/components/settings-shell/ai-detail-client';

export default async function AIModelPage({ params }: { params: Promise<{ slug: string }> }) {
  const session = await getSession();
  if (!session || session.authMethod === 'pam' || session.authMethod === 'cli') redirect('/settings');
  return <AIDetailClient kind="model" id={(await params).slug} />;
}
