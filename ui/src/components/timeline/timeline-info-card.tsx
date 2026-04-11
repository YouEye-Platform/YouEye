/**
 * Timeline Info Card
 *
 * Lazy-loads an info card when the timeline entry becomes visible
 * in the viewport. Uses IntersectionObserver to prevent loading
 * 50+ info cards simultaneously.
 */

"use client";

import { useState, useRef, useEffect } from "react";
import { useInfoCard } from "@/components/info-cards/use-info-card";
import { InfoCard } from "@/components/info-cards/info-card";
import { InfoCardSkeleton } from "@/components/info-cards/info-card-skeleton";
import type { InfoCardSize } from "@/components/info-cards/types";

interface TimelineInfoCardProps {
  infoCardUrl: string;
  size?: InfoCardSize;
  className?: string;
}

export function TimelineInfoCard({
  infoCardUrl,
  size = "default",
  className,
}: TimelineInfoCardProps) {
  const [isVisible, setIsVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // IntersectionObserver: only fetch card data when element enters viewport
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px", threshold: 0 }
    );

    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  // Only fetch when visible
  const { data, loading, error } = useInfoCard(isVisible ? infoCardUrl : null);

  return (
    <div ref={containerRef} className={className}>
      {!isVisible && <InfoCardSkeleton size={size} />}
      {isVisible && loading && <InfoCardSkeleton size={size} />}
      {isVisible && !loading && data && <InfoCard data={data} size={size} />}
      {/* If error or no data, render nothing — entry shows normally */}
    </div>
  );
}
