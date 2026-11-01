import { useState } from "react";
import { ArrowRight, Shuffle } from "lucide-react";
import { Artwork } from "../components";
import icons from "../lib/icons.json";
import { Art, LockButton, type CreativeProps } from "./shared";
import { remix, namedSymbol, type Locks } from "./data";
import { useBrandingTranslations } from "../locale";
import { iconFinishLabel, iconShapeLabel } from "../labels";
// Keep the built-in Symbol visible to React Compiler's generated cache guards.
function StickerSymbol({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 256 256"
      fill="currentColor"
      aria-hidden="true"
      dangerouslySetInnerHTML={{
        __html: icons[name as keyof typeof icons] || icons.sparkle,
      }}
    />
  );
}
export default function StickerMachine(props: CreativeProps) {
  const t = useBrandingTranslations();
  const [heading, emphasis] = t("sticker.heading").split("\n");
  const { d, theme, onChange } = props;
  const [locks, setLocks] = useState<Locks>({
    identity: false,
    finish: false,
    colour: false,
  });
  const [batch, setBatch] = useState(1);
  function roll(part?: keyof Locks) {
    onChange(
      remix(
        d,
        "icon",
        part
          ? {
              identity: part !== "identity",
              finish: part !== "finish",
              colour: part !== "colour",
            }
          : locks,
      ),
    );
    setBatch((n) => n + 1);
  }
  return (
    <div className="w-machine w-builder" data-builder="icon-remix">
      <div className="w-machine-top">
        <div>
          <span className="w-kicker">{t("sticker.kicker")}</span>
          <h2>
            {heading}
            <br />
            <em>{emphasis}</em>
          </h2>
          <p>{t("sticker.intro")}</p>
        </div>
        <div className="w-machine-window">
          <span>{t("sticker.fresh")}</span>
          <Art key={batch} d={d} theme={theme} kind="icon" />
          <small>{t("sticker.unique")}</small>
        </div>
      </div>
      <div className="w-machine-reels">
        {(
          ["identity", "finish", "colour"] as const
        ).map((part) => (
          <div className="w-reel" key={part}>
            <span className="w-reel-label">
              {t(`sticker.${part}.reel`)}
            </span>
            <button
              className="w-reel-choice"
              aria-label={t(`sticker.${part}.change`)}
              disabled={locks[part]}
              onClick={() => roll(part)}
            >
              {part === "identity" ? (
                <>
                  <span className="w-reel-symbol">
                    {d.icon.mode === "symbol" ? (
                      <StickerSymbol name={d.icon.symbol} />
                    ) : (
                      <Artwork design={d} theme={theme} view="icon" />
                    )}
                  </span>
                  <b>{namedSymbol(d, t)}</b>
                </>
              ) : part === "finish" ? (
                <>
                  <Art d={d} theme={theme} kind="icon" />
                  <b>
                    {t("sticker.outfit", { finish: iconFinishLabel(t, d.icon.finish), shape: iconShapeLabel(t, d.icon.shape) })}
                  </b>
                </>
              ) : (
                <>
                  <span className="w-colour-stack">
                    {[d.icon.background, d.icon.foreground, d.icon.accent].map(
                      (c, i) => (
                        <i key={i} style={{ background: c }} />
                      ),
                    )}
                  </span>
                  <b>{t("sticker.colourStory")}</b>
                </>
              )}
              <span className="w-reel-next">
                <Shuffle size={13} />
                {t("sticker.try")}
              </span>
            </button>
            <LockButton
              label={t(`sticker.${part}.label`)}
              part={part}
              locked={locks[part]}
              onClick={() => setLocks({ ...locks, [part]: !locks[part] })}
            />
          </div>
        ))}
      </div>
      <label className="w-match-title">
        <input
          type="checkbox"
          checked={d.icon.match}
          onChange={(event) =>
            onChange({ ...d, icon: { ...d.icon, match: event.target.checked } })
          }
        />
        <span>{t("sticker.match")} <small>{t("sticker.matchHint")}</small></span>
      </label>
      <footer>
        <button
          className="icon-button w-randomize"
          aria-label={t("sticker.random")}
          title={t("sticker.random")}
          disabled={Object.values(locks).every(Boolean)}
          onClick={() => roll()}
        >
          <Shuffle size={20} />
        </button>
        <span>
          {t(Object.values(locks).every(Boolean) ? "sticker.unlockHint" : "sticker.undoHint")}
        </span>
        <button className="w-text-button" onClick={props.onMark}>
          {t("sticker.ownMark")}
          <ArrowRight size={14} />
        </button>
      </footer>
    </div>
  );
}
