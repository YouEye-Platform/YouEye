import { validateEmbedToken } from "@/lib/embed/auth";
import { AppNetworkClient } from "./client";

export default async function AppNetworkEmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ appId: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const { appId } = await params;
  const sp = new URLSearchParams(await searchParams);
  const user = await validateEmbedToken(sp);

  if (!user || !user.isAdmin) {
    return <div style={{ padding: 24, textAlign: "center", color: "#a1a1aa" }}>Unauthorized</div>;
  }

  return <AppNetworkClient appId={appId} />;
}
