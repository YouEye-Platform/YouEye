import { OwnerResetForm } from '@/components/auth/owner-reset-form';

export const dynamic = 'force-dynamic';

/** Public: the owner resets their password with the code shown on the box's console. */
export default function OwnerResetPage() {
  return <OwnerResetForm />;
}
