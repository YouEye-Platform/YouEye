"use client";

import { Brand } from "@youeye/branding/brand";
import type { SiteNameStyle } from "@/lib/wordart-presets";

/**
 * The title as the header shows it, for the "Customise…" rows on Appearance and General. A designed title brings its
 * own light and dark artwork; a plain name is set in the page's own text colour so it reads on either.
 */
export function TitlePreview({ name, style, withIcon = false }: { name: string; style: SiteNameStyle | null; withIcon?: boolean }) {
  return (
    <div className="settings-title-preview">
      {style?.mytitle ? (
        <span className="flex min-w-0 items-center justify-center gap-3">
          {withIcon && <Brand design={style.mytitle} view="icon" className="shrink-0" />}
          <Brand design={style.mytitle} name={name} />
        </span>
      ) : (
        <span className="truncate text-2xl font-semibold tracking-tight text-foreground">{name}</span>
      )}
    </div>
  );
}
