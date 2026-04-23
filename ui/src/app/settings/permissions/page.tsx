import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { PermissionsClient } from "./client";

export default async function PermissionsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isAdmin) redirect("/settings");

  const cpUrl = process.env.CP_INTERNAL_URL || "http://youeye-control.youeye:3000";

  // Fetch all data server-side
  const [bridgesRes, grantsRes, suggestionsRes] = await Promise.all([
    fetch(`${cpUrl}/api/bridges`, { cache: "no-store" }).catch(() => null),
    fetch(`${cpUrl}/api/internet-grants`, { cache: "no-store" }).catch(() => null),
    fetch(`${cpUrl}/api/suggestions`, { cache: "no-store" }).catch(() => null),
  ]);

  const bridges = bridgesRes?.ok ? await bridgesRes.json() : [];
  const grants = grantsRes?.ok ? await grantsRes.json() : [];
  const suggestions = suggestionsRes?.ok ? await suggestionsRes.json() : [];

  return (
    <PermissionsClient
      bridges={bridges}
      grants={grants}
      suggestions={suggestions}
    />
  );
}
