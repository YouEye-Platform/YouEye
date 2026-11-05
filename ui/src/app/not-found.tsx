import { useTranslations as useInterfaceTranslations } from "next-intl";
import Link from "next/link";

export default function NotFound() {
  const translateInterface = useInterfaceTranslations("interface");

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold">404</h1>
        <p className="text-muted-foreground">{translateInterface("ma469ab4ca4e5")}</p>
        <Link
          href="/"
          className="inline-block px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
        >
          {translateInterface("ma0aac9145249")}</Link>
      </div>
    </div>
  );
}
