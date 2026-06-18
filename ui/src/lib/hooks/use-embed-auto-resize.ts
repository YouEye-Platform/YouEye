"use client";

import { useEffect, type RefObject } from "react";

/**
 * useEmbedAutoResize — child side of the UnifiedEmbed `youeye:resize` protocol
 * for UI-served embeds that native apps host in a popover (`/embed/drawer`,
 * `/embed/notifications`). It measures the CONTENT element (passed by ref) and
 * posts its height to the parent (rAF-coalesced) so the host sizes the popover
 * to content instead of a fixed box.
 *
 * Why the content ref and not `document.documentElement`: the root layout's
 * <body> is `min-h-screen`, so the document always reports at least the iframe's
 * own height — measuring it would feed back against the parent's sizing and
 * never shrink. The inner content div has no forced height, so it reflects the
 * true natural height regardless of how tall the iframe currently is.
 */
export function useEmbedAutoResize<T extends HTMLElement>(ref: RefObject<T | null>) {
  useEffect(() => {
    if (typeof window === "undefined" || window.parent === window) return;
    const el = ref.current;
    if (!el) return;

    let last = 0;
    let raf = 0;
    const post = () => {
      raf = 0;
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h > 0 && h !== last) {
        last = h;
        window.parent.postMessage({ type: "youeye:resize", height: h }, "*");
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(post);
    };

    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    schedule(); // initial emit

    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref]);
}
