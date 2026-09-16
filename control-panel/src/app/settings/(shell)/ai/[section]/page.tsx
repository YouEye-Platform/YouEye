import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AIClient } from '@/components/settings-shell/ai-client';
import type { AISection } from '@/components/settings-shell/ai-types';

const sections = new Set<AISection>(['models', 'groups', 'instances', 'providers', 'usage', 'playground']);

export default async function AISectionPage({ params }: { params: Promise<{ section: string }> }) {
  const session = await getSession();
  if (!session || session.authMethod === 'pam' || session.authMethod === 'cli') redirect('/settings');
  const { section } = await params;
  if (!sections.has(section as AISection)) notFound();
  return <AIClient section={section as AISection} />;
}
