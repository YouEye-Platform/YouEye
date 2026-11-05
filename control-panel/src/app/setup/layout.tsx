export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="onboarding-shell min-h-screen bg-background text-foreground flex items-center justify-center p-4">
      {children}
    </div>
  );
}
