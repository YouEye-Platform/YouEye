import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getBranding } from "@/lib/db/queries/branding";
import { getSignedEmbedUrl } from "@/lib/admin/embed-token";
import { BrandingTabs } from "@/components/settings/branding-tabs";

export default async function BrandingPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const branding = await getBranding();

  const serverBrandingUrl = session.isAdmin
    ? getSignedEmbedUrl("branding", session.username, true)
    : null;

  return (
    <BrandingTabs
      siteName={branding.site_name}
      serverDefault={branding.site_name_style ?? {
        fontFamily: "Inter", fontSize: "1.5rem", fontWeight: 700,
        letterSpacing: "0.02em", color: "#ffffff", gradient: null,
        textShadow: "none", textTransform: "none",
      }}
      isAdmin={session.isAdmin ?? false}
      serverBrandingUrl={serverBrandingUrl}
    />
  );
}
