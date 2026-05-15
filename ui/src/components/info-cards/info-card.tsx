"use client";

import type { InfoCardData, InfoCardSize } from "./types";
import { ArticleSummaryCard } from "./cards/article-summary";
import { DefaultCard } from "./cards/default-card";

interface InfoCardProps {
  data: InfoCardData;
  size?: InfoCardSize;
  className?: string;
}

export function InfoCard({ data, size = "default", className }: InfoCardProps) {
  switch (data.cardType) {
    case "article-summary":
      return (
        <ArticleSummaryCard data={data} size={size} className={className} />
      );
    default:
      return <DefaultCard data={data} size={size} className={className} />;
  }
}
