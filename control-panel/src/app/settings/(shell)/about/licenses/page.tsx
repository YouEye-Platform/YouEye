import { redirect } from "next/navigation";

export default async function LicensesRedirectPage() {
  redirect("/settings/general/licenses");
}
