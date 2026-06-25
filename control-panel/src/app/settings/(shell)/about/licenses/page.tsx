import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
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
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");

  return (
    <div>
      <Link
        href="/settings/about"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> About
      </Link>
      <PageHeader
        title="Open source licenses"
        description="YouEye is built on open-source software. Major components and their licenses are listed below."
      />
      <section className="overflow-hidden rounded-xl border bg-card">
        {COMPONENTS.map((c, i) => (
          <div
            key={c.name}
            className={`flex items-center justify-between px-[18px] py-3 ${i ? "border-t" : ""}`}
          >
            <span className="text-sm font-medium">{c.name}</span>
            <span className="text-[13px] text-muted-foreground">{c.license}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
