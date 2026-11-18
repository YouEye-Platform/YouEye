import SetupSecureConnection from '@/components/setup/SetupSecureConnection';

export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="onboarding-shell min-h-screen bg-background text-foreground flex flex-col items-center justify-center gap-4 p-4">
      {children}
      <SetupSecureConnection />
    </div>
  );
}
