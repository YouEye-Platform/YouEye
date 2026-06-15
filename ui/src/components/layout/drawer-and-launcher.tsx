/**
 * DrawerAndLauncher — Plan 5.
 *
 * The dashboard header's app affordance: the quick **drawer** (9-dot popover of
 * pinned apps + search) plus the full-screen **launcher** overlay (all apps +
 * folders) it opens via its "All apps" button. Two cooperating surfaces, one
 * mount. Client wrapper so the server-rendered <Navbar> can stay a server
 * component. (Native apps get the same pairing via the /embed/drawer +
 * /embed/launcher iframes — see app-drawer.tsx and launcher.tsx.)
 *
 * The launcher overlay is PORTALED to document.body: the header has
 * `backdrop-filter` (blur), which makes it a containing block for
 * position:fixed descendants — without the portal the overlay would be trapped
 * inside the 56px header instead of covering the viewport.
 */

"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { AppDrawer } from "./app-drawer";
import { Launcher } from "./launcher";

export function DrawerAndLauncher({ isAdmin = false }: { isAdmin?: boolean }) {
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const close = () => setLauncherOpen(false);

  return (
    <>
      <AppDrawer isAdmin={isAdmin} onOpenLauncher={() => setLauncherOpen(true)} />

      {launcherOpen && mounted &&
        createPortal(
          // pointer-events-none container so the header (above top-14) stays
          // visible AND clickable — matches launcher.html (header peeks through).
          <div className="pointer-events-none fixed inset-0 z-50">
            <div
              className="pointer-events-auto absolute inset-x-0 bottom-0 top-14"
              onClick={close}
            />
            <div className="pointer-events-auto absolute inset-x-4 bottom-4 top-[68px] overflow-hidden rounded-3xl border bg-popover/95 shadow-2xl backdrop-blur-xl sm:inset-x-7 sm:bottom-5">
              <Launcher onClose={close} />
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
