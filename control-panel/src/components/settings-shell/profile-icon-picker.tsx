"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  PROFILE_ICON_CATEGORIES,
  PROFILE_ICON_PRESETS,
  type ProfileIconCategory,
} from "@/lib/profile-icon-presets";

export function ProfileIconPicker({
  selectedId,
  busy,
  onChoose,
  onClose,
}: {
  selectedId?: string | null;
  busy?: boolean;
  onChoose: (id: string) => void;
  onClose?: () => void;
}) {
  const [category, setCategory] = useState<ProfileIconCategory>("Animals");
  const presets = useMemo(() => PROFILE_ICON_PRESETS.filter((preset) => preset.category === category), [category]);

  return (
    <div className="space-y-4" aria-label="Profile icon presets">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold">Choose a picture</h3>
          <p className="mt-1 text-[13px] text-muted-foreground">96 colourful avatars, ready to make your account feel like yours.</p>
        </div>
        {onClose && <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close icon picker"><X className="size-4" /></Button>}
      </div>
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Icon categories">
        {PROFILE_ICON_CATEGORIES.map((item) => (
          <Button
            key={item}
            type="button"
            size="sm"
            variant={category === item ? "default" : "outline"}
            role="tab"
            aria-selected={category === item}
            onClick={() => setCategory(item)}
          >
            {item}
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-8" role="tabpanel">
        {presets.map((preset) => {
          const selected = selectedId === preset.id;
          return (
            <Button
              key={preset.id}
              type="button"
              variant="outline"
              className={`group relative h-14 rounded-xl p-0 ${selected ? "border-primary bg-primary/10 ring-2 ring-primary/20" : "bg-card hover:bg-accent/60"}`}
              disabled={busy}
              onClick={() => onChoose(preset.id)}
              aria-label={`Use ${preset.label} avatar`}
              aria-pressed={selected}
              title={preset.label}
            >
              <span
                aria-hidden="true"
                className="grid size-10 place-items-center rounded-full shadow-sm transition-transform group-hover:scale-105"
                style={{ background: `linear-gradient(135deg, ${preset.background[0]}, ${preset.background[1]})` }}
              >
                {busy && selected ? (
                  <Loader2 className="size-5 animate-spin text-white" />
                ) : (
                  <Image src={preset.artwork} alt="" width={32} height={32} unoptimized className="size-8 object-contain" draggable={false} />
                )}
              </span>
              {selected && !busy && <Check className="absolute right-1 top-1 size-3.5 text-primary" />}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
