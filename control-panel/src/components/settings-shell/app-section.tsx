import type { ReactNode } from "react";

/** One soft group of rows: the only bordered container a section uses, so nothing nests a card in a card. */
export const groupClass = "min-w-0 divide-y overflow-hidden rounded-[.875rem] border bg-card";
/** A row inside a group: text on the left, its control on the right; stacked on a phone. */
export const rowClass = "flex min-w-0 flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between";
/** A native select that matches the text fields. */
export const selectClass = "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30 pointer-coarse:min-h-11";

/**
 * A section of a Settings page: a real heading, an optional line under it, then its content. Sections are set apart
 * by space. The id is the section's anchor (old `?tab=` links scroll to it and focus its heading).
 */
export function AppSection({ id, title, description, action, children }: {
  id: string;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="min-w-0 scroll-mt-24 space-y-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 id={`${id}-heading`} tabIndex={-1} className="text-base font-semibold text-foreground">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
