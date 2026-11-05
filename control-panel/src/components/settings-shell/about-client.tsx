"use client";



import { useTranslations as useInterfaceTranslations } from "next-intl";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronRight, Copy, Globe, Loader2, type LucideIcon, Network, RefreshCw, Server } from "lucide-react";
import { PageHeader } from "@/components/settings-shell/page-header";

interface SystemInfo {
  hostname: string;
  os: string;
  uptime: string;
  primary_ip: string;
}
interface ServiceHealth {
  slug: string;
  version: string;
}
interface TlsStatus {
  mode: string;
  hasExternalCert: boolean;
}

// Versions sometimes come back empty or token-like; only show a short, sane string.
function showVersion(v: string | undefined): string {
  if (!v || v.length > 24 || /\s/.test(v)) return "";
  return v.startsWith("v") || /[a-z]/i.test(v) ? v : `v${v}`;
}


const joinDot = (parts: Array<string | false | undefined | null>) => parts.filter(Boolean).join(" · ");

export function AboutClient({ cpVersion }: { cpVersion?: string }) {
  const translateInterface = useInterfaceTranslations("interface");
function seriesOf(v: string | undefined): string {
  const m = v?.match(/^(\d+)\.(\d+)/);
  return m ? translateInterface("m77bf674b36a4", {version: m[1]+"."+m[2]}) : "YouEye";
}


  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [siteName, setSiteName] = useState("This server");
  const [coreVersion, setCoreVersion] = useState("");
  const [domain, setDomain] = useState<string | null>(null);
  const [caddyRunning, setCaddyRunning] = useState(true);
  const [tls, setTls] = useState<TlsStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    // All admin-gated reads. `/api/settings*` only resolves to CP under the
    // `/settings/api/*` prefix from the root-domain Settings surface; domain/tls/
    // health reach CP directly. Each piece degrades to an honest placeholder on
    // failure (never a fabricated value), and logs — see pitfalls #23 / #28.
    const [settingsR, sysR, healthR, domainR, tlsR] = await Promise.allSettled([
      fetch("/settings/api/settings"),
      fetch("/settings/api/settings/system"),
      fetch("/api/health/services"),
      fetch("/api/domain"),
      fetch("/api/tls/status"),
    ]);

    if (settingsR.status === "fulfilled" && settingsR.value.ok) {
      const s = await settingsR.value.json().catch(() => null);
      if (s?.siteName) setSiteName(s.siteName);
    } else {
      console.error("[About] settings load failed", settingsR);
    }

    if (sysR.status === "fulfilled" && sysR.value.ok) {
      setSys(await sysR.value.json().catch(() => null));
    } else {
      console.error("[About] system info load failed", sysR);
    }

    if (healthR.status === "fulfilled" && healthR.value.ok) {
      const svcs = await healthR.value.json().catch(() => null);
      const spine = Array.isArray(svcs) ? svcs.find((x: ServiceHealth) => x.slug === "spine") : undefined;
      setCoreVersion(showVersion(spine?.version));
    } else {
      console.error("[About] health load failed", healthR);
    }

    if (domainR.status === "fulfilled" && domainR.value.ok) {
      const d = await domainR.value.json().catch(() => null);
      setDomain(d?.domain ?? null);
      setCaddyRunning(d?.caddyRunning ?? false);
    } else {
      console.error("[About] domain load failed", domainR);
    }

    if (tlsR.status === "fulfilled" && tlsR.value.ok) {
      setTls(await tlsR.value.json().catch(() => null));
    } else {
      console.error("[About] tls load failed", tlsR);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const serverSub = sys
    ? joinDot([sys.hostname, sys.os, sys.uptime && translateInterface("m5453281f95f7", {uptime: sys.uptime})])
    : translateInterface("m9e44ee06622c");

  let reach: string;
  if (!caddyRunning) reach = translateInterface("m44f6ecc7f607");
  else if (!domain) reach = translateInterface("m638d8490ddb8");
  else if (!tls) reach = translateInterface("mc94c04650f15");
  else if (tls.hasExternalCert && tls.mode !== "internal") reach = translateInterface("m15df04d604c1");
  else reach = translateInterface("m01571f8c68af");

  const interfaceVersion = showVersion(cpVersion);
  const versionMeta = joinDot([coreVersion && translateInterface("mcceccb335716", {version: coreVersion}), interfaceVersion && translateInterface("m9117b752710a", {version: interfaceVersion})]) || "—";

  return (
    <div>
      <PageHeader title={translateInterface("m4efca0d10c5f")} description={translateInterface("m94a2fa8997ff")} />

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-6">
          <Section title={translateInterface("m524e9b6937a1")}>
            <Row icon={Server} title={siteName} sub={serverSub} />
            <Row icon={Network} title={translateInterface("m0302a467885a")} sub={sys?.primary_ip || "Unavailable"} right={sys?.primary_ip && sys.primary_ip !== "unknown" ? <ButtonCopy value={sys.primary_ip} /> : undefined} />
            <Row icon={Globe} title={domain || translateInterface("meeac8dc98811")} sub={reach} />
          </Section>

          <Section
            title={translateInterface("m9b3289a385a5")}
            headerRight={
              <Link
                href="/settings/system"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-background px-3 text-[13px] font-medium transition-colors hover:bg-accent"
              >
                <RefreshCw className="h-3.5 w-3.5" /> {" "}{translateInterface("mf26f3275e735")}</Link>
            }
          >
            <Row
              title={translateInterface("mc78ffe195710")}
              sub={seriesOf(cpVersion)}
              right={<span className="text-[13px] text-muted-foreground">{versionMeta}</span>}
            />
            <Row
              href="/settings/about/licenses"
              title={translateInterface("m1a1b83db3be8")}
              sub="YouEye is built on open software"
              right={<ChevronRight className="h-4 w-4 text-muted-foreground/60" />}
            />
          </Section>
        </div>
      )}
    </div>
  );
}

function ButtonCopy({ value }: { value: string }) {
  const translateInterface = useInterfaceTranslations("interface");

  const [copied, setCopied] = useState(false);
  return <button type="button" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-primary hover:underline" onClick={() => navigator.clipboard.writeText(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); })}><Copy className="size-3.5" />{copied ? translateInterface("m8d525e5f158b") : translateInterface("me21f935f11d7")}</button>;
}

function Section({ title, headerRight, children }: { title: string; headerRight?: ReactNode; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center justify-between px-[18px] py-3">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {headerRight}
      </div>
      {children}
    </section>
  );
}

function Row({
  icon: Icon,
  title,
  sub,
  right,
  href,
}: {
  icon?: LucideIcon;
  title: string;
  sub?: string;
  right?: ReactNode;
  href?: string;
}) {
  const body = (
    <>
      {Icon && (
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-[18px]" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
        {sub && <div className="truncate text-[13px] text-muted-foreground">{sub}</div>}
      </div>
      {right}
    </>
  );

  if (href) {
    return (
      <Link href={href} className="flex items-center gap-3 border-t px-[18px] py-3 transition-colors hover:bg-accent/50">
        {body}
      </Link>
    );
  }
  return <div className="flex items-center gap-3 border-t px-[18px] py-3">{body}</div>;
}
