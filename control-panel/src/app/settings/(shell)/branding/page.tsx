import { redirect } from "next/navigation";

export default async function BrandingSettingsPage() {
  redirect("/settings/appearance");
}
