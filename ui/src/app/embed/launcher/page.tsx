/**
 * /embed/launcher — Plan 1 Workstream E1.
 *
 * The UI-served app launcher (UI origin). Native apps host this as an iframe in
 * their Canvas header instead of receiving the installed-app list (the E1 security
 * fix). Renders content only — search + app grid + system tiles; the host (or the
 * UI's own overlay) provides the surrounding pop-out panel chrome. Theme via
 * `?mode=light|dark`. Transparent background so the host panel shows through.
 */

"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Launcher } from "@/components/layout/launcher";

function LauncherEmbedInner() {
  const params = useSearchParams();
  const mode = params?.get("mode");

  useEffect(() => {
    if (mode === "dark") document.documentElement.classList.add("dark");
    else if (mode === "light") document.documentElement.classList.remove("dark");
  }, [mode]);

  return (
    <div className="h-screen w-screen">
      <Launcher embedded />
    </div>
  );
}

export default function LauncherEmbedPage() {
  return (
    <Suspense fallback={null}>
      <LauncherEmbedInner />
    </Suspense>
  );
}
