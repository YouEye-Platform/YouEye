import { TitleStudioClient } from "@/components/settings-shell/title-studio-client";
import { getSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";

// The title only you see. The shell shows the way back to Appearance.
export default async function PersonalTitlePage() {
  const session = await getSession();
  if (session?.authMethod === "pam" || session?.authMethod === "cli") {
    redirect("/settings/system");
  }
  return <TitleStudioClient mode="personal" />;
}
