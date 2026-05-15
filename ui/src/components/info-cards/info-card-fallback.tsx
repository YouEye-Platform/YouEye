"use client";

import { AlertCircle } from "lucide-react";

export function InfoCardFallback({
  url,
  error,
}: {
  url?: string;
  error?: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed bg-muted/30 p-3 text-sm text-muted-foreground">
      <AlertCircle className="h-4 w-4 flex-shrink-0" />
      <div>
        {url ? (
          <a
            href={url}
            className="hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            {url}
          </a>
        ) : (
          <span>{error || "Unable to load card"}</span>
        )}
      </div>
    </div>
  );
}
