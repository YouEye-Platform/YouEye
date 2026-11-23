import { redirect } from "next/navigation";

// About became General (Settings redesign, 2026-11-19).
export default async function AboutSettingsPage() {
  redirect("/settings/general");
}
