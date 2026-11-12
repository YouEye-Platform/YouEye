import {useRef,useState} from "react";
import {Search,ChevronLeft,ChevronRight} from "lucide-react";
import type {Design} from "./lib/design";
import icons from "./lib/icons.json";
import {emojiChoices,symbolGroups} from "./lib/icon-styles";
import {ImageReadError, readImage, type ImageReadErrorCode} from "./lib/image";
import {useBrandingTranslations} from "./locale";
import {categoryLabel, symbolLabel} from "./labels";
const searchable=(s:string)=>s.normalize("NFKD").replace(/\p{M}/gu,"").toLowerCase();
export function MarkLibrary({
  design: d,
  onChange,
  onClose,
}: {
  design: Design;
  onChange: (d: Design) => void;
  onClose: () => void;
}) {
  const t = useBrandingTranslations();
  const [mode, setMode] = useState<Design["icon"]["mode"]>(d.icon.mode);
  const [query, setQuery] = useState(""),
    [page, setPage] = useState(0);
  const [category, setCategory] = useState("all");
  const symbols = query
    ? Object.keys(icons).filter((s) =>
        searchable(`${symbolLabel(t, s)} ${s.replaceAll("-", " ")}`).includes(searchable(query.trim())),
      )
    : (symbolGroups[category] || Object.keys(icons)).filter((id) => id in icons);
  const choose = (p: Partial<Design["icon"]>) => {
    onChange({ ...d, icon: { ...d.icon, ...p } });
    onClose();
  };
  const [letters, setLetters] = useState(
    d.icon.letters || Array.from(d.name)[0],
  );
  const [emoji, setEmoji] = useState(d.icon.emoji);
  const file = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<ImageReadErrorCode | null>(null);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(symbols.length / 48) - 1));
  return (
    <div className="cx-library">
      <div className="cx-source-tabs" role="group" aria-label={t("mark.source")}>
        {(
          [
            ["symbol", "mark.symbols"],
            ["monogram", "mark.letters"],
            ["emoji", "mark.emoji"],
            ["upload", "mark.image"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            aria-pressed={mode === id}
            onClick={() => setMode(id)}
          >
            {t(label)}
          </button>
        ))}
      </div>
      {mode === "symbol" ? (
        <>
          <label>{t("mark.category")} <select value={category} onChange={(event) => { setCategory(event.target.value); setPage(0); }}>
            {["all", ...Object.keys(symbolGroups)].map((name) => <option key={name} value={name}>{categoryLabel(t, name)}</option>)}
          </select></label>
          <label className="symbol-search">
            <Search size={16} />
            <input
              autoFocus
              aria-label={t("mark.find")}
              placeholder={t("mark.search", { count: Object.keys(icons).length })}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
          </label>
          <div className="cx-symbols">
            {symbols.slice(currentPage * 48, (currentPage + 1) * 48).map((s) => (
              <button
                key={s}
                title={symbolLabel(t, s)}
                aria-label={t("common.use", { label: symbolLabel(t, s) })}
                aria-pressed={d.icon.mode === "symbol" && d.icon.symbol === s}
                onClick={() => choose({ mode: "symbol", symbol: s })}
              >
                <svg
                  viewBox="0 0 256 256"
                  fill="currentColor"
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{
                    __html: icons[s as keyof typeof icons],
                  }}
                />
              </button>
            ))}
          </div>
          {!symbols.length && (
            <p className="cx-empty">
              {t("mark.empty")}
            </p>
          )}
          <div className="cx-library-paging">
            <button
              className="icon-button"
              disabled={currentPage === 0}
              aria-label={t("mark.previous")}
              onClick={() => setPage(currentPage - 1)}
            >
              <ChevronLeft size={18} />
            </button>
            <span>
              {symbols.length
                ? t("common.range", { start: currentPage * 48 + 1, end: Math.min((currentPage + 1) * 48, symbols.length), total: symbols.length })
                : t("mark.zero")}
            </span>
            <button
              className="icon-button"
              disabled={(currentPage + 1) * 48 >= symbols.length}
              aria-label={t("mark.next")}
              onClick={() => setPage(currentPage + 1)}
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </>
      ) : mode === "monogram" ? (
        <div className="cx-source-entry">
          <label>
            {t("mark.initials")}
            <input
              aria-label={t("mark.iconLetters")}
              value={letters}
              maxLength={6}
              onChange={(e) => setLetters(e.target.value)}
            />
          </label>
          <button
            className="primary"
            disabled={!letters.trim()}
            onClick={() =>
              choose({ mode: "monogram", letters: letters.trim() })
            }
          >
            {t("mark.useLetters")}
          </button>
        </div>
      ) : mode === "emoji" ? (
        <>
          <div className="cx-emoji-grid">
            {emojiChoices.map((s) => (
              <button
                key={s}
                aria-label={t("common.use", { label: s })}
                onClick={() => choose({ mode: "emoji", emoji: s })}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="cx-source-entry">
            <label>
              {t("mark.yourEmoji")}
              <input
                aria-label={t("mark.customEmoji")}
                maxLength={32}
                value={emoji}
                onChange={(e) => setEmoji(e.target.value)}
              />
            </label>
            <button
              className="primary"
              disabled={!emoji.trim()}
              onClick={() => choose({ mode: "emoji", emoji: emoji.trim() })}
            >
              {t("mark.useEmoji")}
            </button>
          </div>
        </>
      ) : (
        <div className="cx-upload">
          <p>{t("mark.pictureIntro")}</p>
          {uploadError && <p role="alert">{t(uploadError)}</p>}
          <button className="secondary" onClick={() => file.current?.click()}>
            {t("mark.chooseImage")}
          </button>
          <small>{t("mark.imageHint")}</small>
          <input
            ref={file}
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setUploadError(null);
              try {
                choose({ mode: "upload", image: await readImage(f) });
              } catch (error) {
                setUploadError(
                  error instanceof ImageReadError ? error.code : "upload.readError",
                );
              }
              e.target.value = "";
            }}
          />
        </div>
      )}
    </div>
  );
}
