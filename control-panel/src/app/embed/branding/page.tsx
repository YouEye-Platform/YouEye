import { validateEmbedToken } from "@/lib/embed/auth";
import { BrandingEmbedClient } from "./client";

export default async function BrandingEmbedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const params = new URLSearchParams(await searchParams);
  const user = await validateEmbedToken(params);

  if (!user || !user.isAdmin) {
    return <div style={{ padding: 24, textAlign: "center", color: "#a1a1aa" }}>Unauthorized</div>;
  }

  return <BrandingEmbedClient />;
}
