import { TitleStudioClient } from "@/components/settings-shell/title-studio-client";
import { getSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";

// The server's name and title, for everyone. The shell shows the way back to General.
export default async function ServerTitlePage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect("/settings");
  return <TitleStudioClient mode="server" />;
}
