import { useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Moon,
  Sun,
  Shuffle,
  Sparkles,
  Search,
} from "lucide-react";
import { Modal } from "../components";
import { compatibleFonts, palettes, type Design } from "../lib/design";
import { Art, NameField, type CreativeProps } from "./shared";
import { paint, type Locks } from "./data";
import { useBrandingTranslations } from "../locale";
import { paletteLabel } from "../labels";
import {
  applyTitleStyle,
  paletteIndex,
  randomName,
  shuffleTitle,
  styleIndex,
  titleStyles,
} from "./starter";


type Part = keyof Locks;
const parts: Part[] = ["identity", "colour", "finish"];
// This is a lettering sample rendered as artwork, not interface copy.
const fontPreviewText = "Aa";
export default function TitleBuilder(props: CreativeProps) {
  const t = useBrandingTranslations();
  const { d, theme, onChange, onTheme, onNext } = props;
  const [localLocks, setLocalLocks] = useState<Locks>({
    identity: false,
    colour: false,
    finish: false,
  });
  const locks = props.titleLocks ?? localLocks;
  const setLocks = props.onTitleLocks ?? setLocalLocks;
  const [menu, setMenu] = useState<Part | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const fonts = compatibleFonts(d.uppercase ? d.name.toUpperCase() : d.name);
  const options = (key: Part) =>
    key === "identity"
      ? fonts.map(([id, label]) => ({ id, label, design: { ...d, font: id } }))
      : key === "colour"
        ? palettes.map((p, i) => ({
            id: String(i),
            label: paletteLabel(t, p[0]),
            design: paint(d, "title", p),
          }))
        : titleStyles.map((s, i) => ({
            id: s.id,
            label: t(s.labelKey),
            design: applyTitleStyle(d, i),
          }));
  const selected = (key: Part) =>
    key === "identity"
      ? fonts.findIndex(([id]) => id === d.font)
      : key === "colour"
        ? paletteIndex(d)
        : styleIndex(d);
  const label = (key: Part) =>
    options(key)[selected(key)]?.label ??
    t(key === "identity" ? "font.noneSingle" : "common.custom");
  function change(key: Part, next: Design) {
    setLocks({ ...locks, [key]: false });
    onChange(next);
  }
  function cycle(key: Part, delta: number) {
    const choices = options(key);
    if (!choices.length) return;
    const i = selected(key);
    change(
      key,
      choices[
        i < 0
          ? delta > 0
            ? 0
            : choices.length - 1
          : (i + delta + choices.length) % choices.length
      ].design,
    );
  }
  function randomise(key?: Part) {
    onChange(
      shuffleTitle(
        d,
        key
          ? {
              identity: key !== "identity",
              colour: key !== "colour",
              finish: key !== "finish",
            }
          : locks,
      ),
    );
  }
  const filtered = menu
    ? options(menu).filter((o) =>
        o.label.toLowerCase().includes(query.toLowerCase()),
      )
    : [];
  // A locale change can change search results while the chooser stays open.
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 12) - 1));
  const visible = filtered.slice(currentPage * 12, currentPage * 12 + 12);
  const allDone = Object.values(locks).every(Boolean);
  return (
    <div className="t-builder w-builder" data-builder="title-remix">
      <header className="t-heading">
        <span className="w-kicker">{t("title.kicker")}</span>
        <h2>{t("title.heading")}</h2>
      </header>
      <div className="t-name-row">
        <NameField {...props} label={t("title.nameLabel")} />
        <button
          className="t-icon"
          aria-label={t("title.suggest")}
          title={t("title.tryName")}
          onClick={() => onChange({ ...d, name: randomName(d.name) })}
        >
          <Shuffle size={19} />
        </button>
      </div>
      <p className="t-reassurance">
        {t("title.reassurance")}
      </p>
      <div className="t-screen" style={{ background: d[theme].surface }}>
        <button
          className="t-theme"
          onClick={onTheme}
          aria-label={t(theme === "light" ? "title.previewDark" : "title.previewLight")}
          title={t(theme === "light" ? "title.previewDark" : "title.previewLight")}
        >
          {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
        </button>
        <Art d={d} kind="title" theme={theme} />
      </div>
      <div className="t-ingredients">
        {parts.map((key) => (
          <section className="t-ingredient" data-part={key} key={key}>
            <header>
              <span>{t(`title.${key}.label`)}</span>
              <button
                className="t-icon t-random"
                disabled={locks[key] || !options(key).length}
                aria-label={t(`title.${key}.random`)}
                title={t(locks[key] ? `title.${key}.untick` : `title.${key}.random`)}
                onClick={() => randomise(key)}
              >
                <Shuffle size={16} />
              </button>
            </header>
            <div className="t-choice-row">
              <button
                className="t-cycle"
                aria-label={t(`title.${key}.previous`)}
                disabled={!options(key).length}
                onClick={() => cycle(key, -1)}
              >
                <ChevronLeft size={19} />
              </button>
              <button
                className="t-choice"
                aria-label={t(`title.${key}.choose`)}
                aria-haspopup="dialog"
                onClick={() => {
                  setMenu(key);
                  setQuery("");
                  setPage(0);
                }}
              >
                {key === "colour" ? (
                  <span className="t-swatch-stack">
                    {[d.light.ink, d.light.secondary, d.dark.ink].map(
                      (c, i) => (
                        <i key={i} style={{ background: c }} />
                      ),
                    )}
                  </span>
                ) : (
                  <Art
                    d={
                      key === "identity"
                        ? {
                            ...d,
                            name: fontPreviewText,
                            effect: "flat",
                            shape: "straight",
                            outline: 0,
                          }
                        : d
                    }
                    kind="title"
                    theme={theme}
                  />
                )}
                <strong>{label(key)}</strong>
                <small>{t(`title.${key}.browse`)}</small>
              </button>
              <button
                className="t-cycle"
                aria-label={t(`title.${key}.next`)}
                disabled={!options(key).length}
                onClick={() => cycle(key, 1)}
              >
                <ChevronRight size={19} />
              </button>
            </div>
            <button
              className="t-done"
              aria-label={t(locks[key] ? `title.${key}.unlock` : `title.${key}.done`)}
              title={t(locks[key] ? `title.${key}.kept` : `title.${key}.keep`)}
              aria-pressed={locks[key]}
              onClick={() => setLocks({ ...locks, [key]: !locks[key] })}
            >
              <Check size={19} />
            </button>
          </section>
        ))}
      </div>
      <footer className="t-actions">
        <div>
          <button
            className="t-surprise"
            onClick={() => randomise()}
            disabled={allDone}
          >
            <Sparkles size={18} />
            {t("title.surprise")}
          </button>
          <small>
            {t(allDone ? "title.allKept" : "title.keepHint")}
          </small>
        </div>
        <button className="t-next" onClick={onNext}>
          {t("title.next")}
          <ArrowRight size={19} />
        </button>
      </footer>
      <Modal
        open={menu !== null}
        title={t(menu ? `title.${menu}.dialog` : "title.chooseLook")}
        onClose={() => setMenu(null)}
      >
        <div className="t-menu">
          <label className="t-search">
            <Search size={17} />
            <input
              aria-label={t("title.search")}
              placeholder={t(menu === "identity" ? "title.findFont" : "title.findLook")}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
          </label>
          <div className="t-option-grid">
            {visible.map((o) => (
              <button
                key={o.id}
                className="t-option"
                aria-label={t("common.use", { label: o.label })}
                aria-pressed={
                  menu !== null && o.id === options(menu)[selected(menu)]?.id
                }
                onClick={() => {
                  if (menu) change(menu, o.design);
                }}
              >
                <Art d={o.design} kind="title" theme={theme} />
                <span>
                  {o.label}
                  {menu !== null &&
                    o.id === options(menu)[selected(menu)]?.id && (
                      <Check size={15} />
                    )}
                </span>
              </button>
            ))}
          </div>
          {!filtered.length && (
            <p className="t-empty">
              {t(menu === "identity" && !fonts.length ? "title.noFont" : "title.noMatches")}
            </p>
          )}
          <footer className="t-menu-footer">
            <div className="t-pages">
              <button
                aria-label={t("title.previousChoices")}
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                <ChevronLeft size={18} />
              </button>
              <span>
                {filtered.length
                  ? t("common.range", { start: currentPage * 12 + 1, end: Math.min((currentPage + 1) * 12, filtered.length), total: filtered.length })
                  : t("title.zeroChoices")}
              </span>
              <button
                aria-label={t("title.moreChoices")}
                disabled={(currentPage + 1) * 12 >= filtered.length}
                onClick={() => setPage(currentPage + 1)}
              >
                <ChevronRight size={18} />
              </button>
            </div>
            <button className="t-next" onClick={() => setMenu(null)}>
              <Check size={17} />
              {t("common.done")}
            </button>
          </footer>
        </div>
      </Modal>
    </div>
  );
}
