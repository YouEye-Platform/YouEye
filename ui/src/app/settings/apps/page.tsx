import { redirect } from "next/navigation";

export default function AppsSettingsRedirect() {
  redirect("/settings/connectors");
}
