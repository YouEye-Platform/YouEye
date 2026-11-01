import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type ReactElement,
  isValidElement,
  cloneElement,
} from "react";
import { X, LockKeyhole, LockKeyholeOpen } from "lucide-react";
import type { Design, Theme, View } from "./lib/design";
import { supportsText, fontForText } from "./lib/coverage";
import { ensureFont } from "./lib/fonts";
import { renderSvg } from "./lib/render";
import { useBrandingTranslations } from "./locale";
export function Artwork({
  design,
  theme = "light",
  view = "title",
  background = false,
  compact = false,
  className = "",
}: {
  design: Design;
  theme?: Theme;
  view?: View;
  background?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const t = useBrandingTranslations();
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [, refresh] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setError(false);
    Promise.all([
      ensureFont(design.font),
      ensureFont("spacegrotesk"),
      ensureFont("oswald"),
      ...(design.icon.mode === "monogram"
        ? [
            fontForText(
              design.font,
              design.icon.letters || Array.from(design.name)[0],
            ),
          ]
            .filter((id): id is string => !!id)
            .map(ensureFont)
        : []),
    ])
      .then(() => active && refresh((n) => n + 1))
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, [design.font, design.icon.mode, design.icon.letters, design.name]);
  return (
    <div className={`artwork ${className}`} aria-busy={error || undefined}>
      {view !== "icon" &&
      !supportsText(
        design.font,
        design.uppercase ? design.name.toUpperCase() : design.name,
      ) ? (
        <span className="font-error">
          {t("artwork.titleFontError")}
        </span>
      ) : null}
      {view !== "title" &&
      design.icon.mode === "monogram" &&
      !fontForText(
        design.font,
        design.icon.letters || Array.from(design.name)[0],
      ) ? (
        <span className="font-error">{t("artwork.initialsFontError")}</span>
      ) : null}
      {error ? (
        <span className="font-error">
          {t("artwork.loadError")}
        </span>
      ) : null}
      <div
        dangerouslySetInnerHTML={{
          __html:
            renderSvg(design, theme, view, id, background, compact, {
              label: t(view === "icon" ? "artwork.iconLabel" : "artwork.identityLabel", { name: design.name }),
              title: t("artwork.documentTitle", { name: design.name }),
            })
        }}
      />
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {isValidElement(children)
        ? cloneElement(
            children as ReactElement<{
              id?: string;
              "aria-describedby"?: string;
            }>,
            { id, "aria-describedby": hint ? id + "-help" : undefined },
          )
        : children}
      {hint && <small id={id + "-help"}>{hint}</small>}
    </div>
  );
}

export function Range({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  unit = "",
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  unit?: string;
}) {
  const t = useBrandingTranslations();
  return (
    <label className="range-field">
      <span>
        {label}
        <output>
          {t("common.number", { value })}
          {unit}
        </output>
      </span>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
export function Colours({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="colour-field">
      <span>{label}</span>
      <div>
        <input
          type="color"
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <span>{value.toUpperCase()}</span>
      </div>
    </label>
  );
}
export function Segments<T extends string>({
  value,
  items,
  onChange,
  label,
}: {
  value: T;
  items: readonly (T | readonly [T, string])[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segments" role="group" aria-label={label}>
      {items.map((item) => {
        const v = Array.isArray(item) ? item[0] : item;
        const text = Array.isArray(item) ? item[1] : item;
        return (
          <button
            key={v}
            className={v === value ? "selected" : ""}
            aria-pressed={v === value}
            onClick={() => onChange(v as T)}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}
export function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="toggle">
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
export function Lock({
  locked,
  onChange,
  label,
}: {
  locked: boolean;
  onChange: () => void;
  label: string;
}) {
  const t = useBrandingTranslations();
  return (
    <button
      className={`icon-button ${locked ? "active" : ""}`}
      aria-label={t(locked ? "common.unlock" : "common.lock", { label })}
      aria-pressed={locked}
      title={t(locked ? "common.unlockShuffle" : "common.lockShuffle", { label })}
      onClick={onChange}
    >
      {locked ? <LockKeyhole size={15} /> : <LockKeyholeOpen size={15} />}
    </button>
  );
}
export function Modal({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useBrandingTranslations();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (open && !el?.open) el?.showModal();
    if (!open && el?.open) el?.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <button
          className="icon-button"
          aria-label={t("common.closeDialog")}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
