import { redirect } from "next/navigation";

export default function ConnectorsSettingsRedirect() {
  redirect("/settings/apps");
}
