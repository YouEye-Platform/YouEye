import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowRight,
  Check,
  LockKeyhole,
  LockKeyholeOpen,
  Palette,
  Pencil,
  Shuffle,
} from "lucide-react";
import { Artwork } from "../components";
import {
  compatibleFonts,
  palettes,
  type Design,
  type Theme,
} from "../lib/design";
import { iconStyles, applyIconStyle } from "../lib/icon-styles";
import { effects, finish, paint, type Kind, type Locks } from "./data";
import { useBrandingTranslations } from "../locale";
import { paletteLabel } from "../labels";

// This is default document content, not an interface label.
const untitledArtworkName = "Untitled";
export type CreativeProps = {
  d: Design;
  theme: Theme;
  kind: Kind;
  onChange: (d: Design) => void;
  onMark: () => void;
  onColours: () => void;
  onDetails: () => void;
  onTheme?: () => void;
  onNext?: () => void;
  titleLocks?: Locks;
  onTitleLocks?: (locks: Locks) => void;
};
export function Art({
  d,
  theme,
  kind,
  className = "",
  children,
}: {
  d: Design;
  theme: Theme;
  kind: Kind;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`w-art w-art-${kind} ${className}`}
      style={{ "--art-surface": d[theme].surface } as CSSProperties}
    >
      <Artwork
        design={d}
        theme={theme}
        view={kind}
        compact={kind === "title"}
      />
      {children}
    </div>
  );
}
export function NameField({
  d,
  onChange,
  label,
}: Pick<CreativeProps, "d" | "onChange"> & { label?: string }) {
  const t = useBrandingTranslations();
  const [value, setValue] = useState(d.name);
  useEffect(() => setValue(d.name), [d.name]);
  return (
    <label className="w-name">
      <span>
        <Pencil size={13} />
        {label ?? t("name.defaultLabel")}
      </span>
      <input
        aria-label={t("name.title")}
        value={value}
        maxLength={64}
        onChange={(e) => {
          setValue(e.target.value);
          if (e.target.value.trim()) onChange({ ...d, name: e.target.value });
        }}
        onBlur={() => {
          const name = value.trim() || untitledArtworkName;
          setValue(name);
          onChange({ ...d, name });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </label>
  );
}
export function Swatches({
  d,
  kind,
  onChange,
  onColours,
  indices,
}: CreativeProps & { indices?: number[] }) {
  const t = useBrandingTranslations();
  const list = indices
    ? indices.map((i) => palettes[i])
    : palettes.slice(0, 12);
  const ink =
    kind === "title" || d.icon.match ? d.light.ink : d.icon.foreground;
  return (
    <div className="w-swatches" role="group" aria-label={t("colours.combinations")}>
      {list.map((p) => (
        <button
          key={p[0]}
          aria-label={t("colours.use", { label: paletteLabel(t, p[0]) })}
          aria-pressed={p[1] === ink}
          title={paletteLabel(t, p[0])}
          style={{
            background: `linear-gradient(135deg,${p[1]} 50%,${p[2]} 50%)`,
          }}
          onClick={() => onChange(paint(d, kind, p))}
        >
          {p[1] === ink && <Check size={13} />}
        </button>
      ))}
      <button
        className="w-all-colours"
        onClick={onColours}
        aria-label={t("colours.more")}
        title={t("colours.mix")}
      >
        <Palette size={18} />
      </button>
    </div>
  );
}
export function FontSelect({ d, onChange }: CreativeProps) {
  const t = useBrandingTranslations();
  const fonts = compatibleFonts(d.uppercase ? d.name.toUpperCase() : d.name);
  return (
    <label className="w-field">
      {t("font.lettering")}
      <select
        aria-label={t("font.lettering")}
        disabled={!fonts.length}
        value={fonts.length ? d.font : ""}
        onChange={(e) =>
          onChange({ ...d, font: e.target.value as Design["font"] })
        }
      >
        {!fonts.length && <option value="">{t("font.none")}</option>}
        {fonts.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
export function FinishTiles(props: CreativeProps & { compact?: boolean }) {
  const t = useBrandingTranslations();
  const { d, theme, kind, onChange, compact } = props;
  return (
    <div className={`w-finish-tiles ${compact ? "w-small-tiles" : ""}`}>
      {kind === "title"
        ? effects.slice(0, compact ? 6 : 10).map(([effect, nameKey]) => (
            <button
              key={effect}
              aria-label={t("finish.use", { label: t(nameKey) })}
              aria-pressed={d.effect === effect}
              onClick={() => onChange(finish(d, effect))}
            >
              <Art d={finish(d, effect)} kind="title" theme={theme} />
              <span>{t(nameKey)}</span>
            </button>
          ))
        : iconStyles.map((s) => (
            <button
              key={s.nameKey}
              aria-label={t("finish.outfit", { label: t(s.nameKey) })}
              onClick={() =>
                onChange({ ...d, icon: applyIconStyle(d.icon, s) })
              }
            >
              <Art
                d={{ ...d, icon: applyIconStyle(d.icon, s) }}
                kind="icon"
                theme={theme}
              />
              <span>{t(s.nameKey)}</span>
            </button>
          ))}
    </div>
  );
}
export function LockButton({
  locked,
  onClick,
  label,
  part,
}: {
  locked: boolean;
  onClick: () => void;
  label: string;
  part?: keyof Locks;
}) {
  const t = useBrandingTranslations();
  return (
    <button
      className="w-lock"
      aria-label={part
        ? t(locked ? `sticker.${part}.unlock` : `sticker.${part}.lock`)
        : t(locked ? "common.unlock" : "common.lock", { label })}
      aria-pressed={locked}
      onClick={onClick}
    >
      {locked ? <LockKeyhole size={14} /> : <LockKeyholeOpen size={14} />}
      <span>
        {part
          ? t(locked ? `sticker.${part}.keeping` : `sticker.${part}.keep`)
          : t(locked ? "common.keeping" : "common.keep", { label })}
      </span>
    </button>
  );
}
export function RangeControl({
  label,
  value,
  min = 0,
  max = 100,
  onChange,
  ends,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (n: number) => void;
  ends?: [string, string];
}) {
  const t = useBrandingTranslations();
  return (
    <label className="w-range">
      <span>
        {label}
        <output>{t("common.number", { value })}</output>
      </span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
      />
      {ends && (
        <small>
          <span>{ends[0]}</span>
          <span>{ends[1]}</span>
        </small>
      )}
    </label>
  );
}
export function SectionLabel({
  number,
  children,
}: {
  number: string;
  children: ReactNode;
}) {
  return (
    <h3 className="w-section-label">
      <span>{number}</span>
      {children}
    </h3>
  );
}
export function Action({
  children,
  onClick,
  disabled = false,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button className="w-action" onClick={onClick} disabled={disabled}>
      {children}
      <ArrowRight size={17} />
    </button>
  );
}
export function ShuffleButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label?: string;
}) {
  const t = useBrandingTranslations();
  return (
    <button className="w-action" onClick={onClick}>
      <Shuffle size={17} />
      {label ?? t("common.remix")}
    </button>
  );
}
