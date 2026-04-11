export interface InfoCardData {
  cardType: string;
  sourceApp: string;
  title: string;
  description?: string;
  thumbnailUrl?: string;
  facts?: { label: string; value: string }[];
  actions?: { label: string; url: string; type: "link" | "action" }[];
  metadata?: Record<string, unknown>;
}

export type InfoCardSize = "compact" | "default" | "expanded";
