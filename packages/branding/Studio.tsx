"use client";

import { useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Moon, Sun, Undo2 } from "lucide-react";
import { defaultDesign, designSchema, fitDesign, type Design, type Theme } from "./lib/design";
import TitleBuilder from "./creative/TitleBuilder";
import StickerMachine from "./creative/StickerMachine";
import { Modal, Artwork } from "./components";
import { MarkLibrary } from "./MarkLibrary";
import type { Locks } from "./creative/data";
import { useBrandingTranslations } from "./locale";
import "./style.css";

/** The editable v1 document is the only durable state. Locks/history stay local. */
export function TitleStudio({
  design, onChange, onContinue, onBack, initialStage = "title",
}: {
  design: Design;
  onChange: (design: Design) => void;
  onContinue?: () => void;
  onBack?: () => void;
  initialStage?: "title" | "icon";
}) {
  const t = useBrandingTranslations();
  const [stage, setStage] = useState(initialStage);
  const [theme, setTheme] = useState<Theme>("light");
  const [markOpen, setMarkOpen] = useState(false);
  const [history, setHistory] = useState<Design[]>([]);
  const current = useRef(design);
  current.current = design;
  const [titleLocks, setTitleLocks] = useState<Locks>({ identity: false, colour: false, finish: false });

  function change(next: Design) {
    const parsed = fitDesign(designSchema.parse(next));
    if (JSON.stringify(parsed) === JSON.stringify(current.current)) return;
    const previous = current.current;
    setHistory((items) => [...items.slice(-19), previous]);
    current.current = parsed;
    onChange(parsed);
  }
  function undo() {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((items) => items.slice(0, -1));
    current.current = previous;
    onChange(previous);
  }
  const props = {
    d: design, theme, kind: stage, onChange: change,
    onMark: () => setMarkOpen(true),
    onColours: () => setMarkOpen(true), onDetails: () => setMarkOpen(true),
    onTheme: () => setTheme((value) => value === "light" ? "dark" : "light"),
    onNext: () => setStage("icon"), titleLocks, onTitleLocks: setTitleLocks,
  };
  return (
    <div className="mytitle-scope">
      <div className="wild-studio" data-artwork-theme={theme}>
        <div className="studio-actions">
          <button type="button" onClick={() => stage === "icon" ? setStage("title") : onBack?.()} disabled={stage === "title" && !onBack}>
            <ArrowLeft size={16} />{t(stage === "icon" ? "studio.title" : "studio.back")}
          </button>
          <button type="button" onClick={undo} disabled={!history.length}><Undo2 size={16} />{t("studio.undo")}</button>
          <button type="button" onClick={props.onTheme} aria-label={t("studio.switchBackground")}>
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}{t("studio.background")}
          </button>
        </div>
        <div hidden={stage !== "title"}><TitleBuilder {...props} kind="title" /></div>
        <div hidden={stage !== "icon"}>
          <StickerMachine {...props} kind="icon" />
          <div className="studio-sizes" aria-label={t("studio.smallPreviews")}>
            {[16, 32, 48].map((size) => <div key={size}><div style={{ width: size, height: size }}><Artwork design={design} theme={theme} view="icon" /></div><small>{t("studio.previewSize", { size })}</small></div>)}
          </div>
          {onContinue && <div className="studio-actions"><button type="button" className="primary" onClick={onContinue}>{t("studio.use")} <ArrowRight size={16} /></button></div>}
        </div>
      </div>
      <Modal title={t("studio.chooseMark")} open={markOpen} onClose={() => setMarkOpen(false)}>
        <MarkLibrary design={design} onChange={change} onClose={() => setMarkOpen(false)} />
      </Modal>
    </div>
  );
}

export function initialDesign(name: string): Design {
  return fitDesign({ ...structuredClone(defaultDesign), name: name || "YouEye", icon: { ...defaultDesign.icon, mode: "monogram", letters: "" } });
}
