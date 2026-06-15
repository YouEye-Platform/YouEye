/**
 * DrawerAndLauncher — Plan 5.
 *
 * The dashboard header's app affordance: the quick **drawer** (9-dot popover of
 * pinned apps + search) plus the full-screen **launcher** overlay (all apps +
 * folders) it opens via its "All apps" button. Two cooperating surfaces, one
 * mount. Client wrapper so the server-rendered <Navbar> can stay a server
 * component. (Native apps get the same pairing via the /embed/drawer +
 * /embed/launcher iframes — see app-drawer.tsx and launcher.tsx.)
 */

"use client";

import { useState } from "react";
import { AppDrawer } from "./app-drawer";
import { Launcher } from "./launcher";

export function DrawerAndLauncher({ isAdmin = false }: { isAdmin?: boolean }) {
  const [launcherOpen, setLauncherOpen] = useState(false);

  return (
    <>
      <AppDrawer isAdmin={isAdmin} onOpenLauncher={() => setLauncherOpen(true)} />

      {launcherOpen && (
        // Below the header (z-40 < header z-50) so the header stays visible — matches launcher.html.
        <div className="fixed inset-0 z-40">
          <div className="absolute inset-0" onClick={() => setLauncherOpen(false)} />
          <div className="absolute inset-x-4 bottom-4 top-[68px] overflow-hidden rounded-3xl border bg-popover/95 shadow-2xl backdrop-blur-xl sm:inset-x-7 sm:bottom-5">
            <Launcher onClose={() => setLauncherOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}
