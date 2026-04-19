import { validateEmbedToken } from "@/lib/embed/auth";
import { BackupEmbedClient } from "./client";

export default async function BackupEmbedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const params = new URLSearchParams(await searchParams);
  const user = await validateEmbedToken(params);

  if (!user || !user.isAdmin) {
    return <div style={{ padding: 24, textAlign: "center", color: "#a1a1aa" }}>Unauthorized</div>;
  }

  return <BackupEmbedClient />;
}
