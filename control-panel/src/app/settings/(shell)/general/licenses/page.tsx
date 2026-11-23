import { getTranslations as getInterfaceTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { PageHeader } from "@/components/settings-shell/page-header";

// Major open-source components the platform actually ships (README "Tech Stack").
// This is attribution, not runtime config — it does not guess or mask anything.
const COMPONENTS: Array<{ name: string; license: string }> = [
  { name: "YouEye platform", license: "Business Source License 1.1" },
  { name: "Next.js", license: "MIT" },
  { name: "React", license: "MIT" },
  { name: "Node.js", license: "MIT" },
  { name: "Go", license: "BSD-3-Clause" },
  { name: "PostgreSQL", license: "PostgreSQL License" },
  { name: "Caddy", license: "Apache-2.0" },
  { name: "Pi-hole", license: "EUPL-1.2" },
  { name: "Incus", license: "Apache-2.0" },
  { name: "Drizzle ORM", license: "Apache-2.0" },
  { name: "Radix UI", license: "MIT" },
  { name: "Tailwind CSS", license: "MIT" },
  { name: "lucide", license: "ISC" },
  { name: "Framer Motion", license: "MIT" },
];

export default async function LicensesPage() {
  const translateInterface = await getInterfaceTranslations("interface");

  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  return (
    <div>
      <PageHeader
        title={translateInterface("m1a1b83db3be8")}
        description={translateInterface("m9f59b1b1bba4")}
      />
      <ul className="settings-group max-w-[46rem]">
        {COMPONENTS.map((c) => (
          <li key={c.name} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-3">
            <span className="min-w-0 text-sm font-medium">{c.name}</span>
            <span className="min-w-0 text-[13px] text-muted-foreground">{c.license}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
