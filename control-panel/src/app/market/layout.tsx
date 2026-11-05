import { MarketShell } from "@/components/control-surface/market-shell";

export default function MarketLayout({ children }: { children: React.ReactNode }) {
  return <MarketShell>{children}</MarketShell>;
}
