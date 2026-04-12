'use client';

import { useState, useEffect, useRef, useMemo, CSSProperties } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { SiteNameStyle } from '@/lib/db/queries/branding';
import {
  FONT_PRESETS, EFFECT_PRESETS, COLOUR_PRESETS, SHAPE_PRESETS,
  composeStyle,
} from '@/lib/wordart-presets';

const FONT_CSS_MAP: Record<string, string> = {
  'Montserrat': '/fonts/montserrat.css', 'Playfair Display': '/fonts/playfair-display.css',
  'Inter': '/fonts/inter.css', 'Poppins': '/fonts/poppins.css',
  'Space Grotesk': '/fonts/space-grotesk.css', 'JetBrains Mono': '/fonts/jetbrains-mono.css',
  'Raleway': '/fonts/raleway.css', 'Caveat': '/fonts/caveat.css',
  'Outfit': '/fonts/outfit.css', 'Plus Jakarta Sans': '/fonts/plus-jakarta-sans.css',
  'Lobster': '/fonts/lobster.css', 'Permanent Marker': '/fonts/permanent-marker.css',
  'Orbitron': '/fonts/orbitron.css', 'Abril Fatface': '/fonts/abril-fatface.css',
  'Pacifico': '/fonts/pacifico.css', 'Bungee': '/fonts/bungee.css',
  'Russo One': '/fonts/russo-one.css', 'Fredoka': '/fonts/fredoka.css',
  'Satisfy': '/fonts/satisfy.css', 'Righteous': '/fonts/righteous.css',
};

function usePreloadFonts() {
  useEffect(() => {
    Object.entries(FONT_CSS_MAP).forEach(([family, cssPath]) => {
      const id = `gf-${family.replace(/\s+/g, '-')}`;
      if (document.getElementById(id)) return;
      const link = document.createElement('link');
      link.id = id; link.rel = 'stylesheet'; link.href = cssPath;
      document.head.appendChild(link);
    });
  }, []);
}

function PickerRow<T extends { id: string; name: string }>({
  label, items, selectedIndex, onSelect, renderItem,
}: { label: string; items: T[]; selectedIndex: number; onSelect: (i: number) => void; renderItem: (item: T, sel: boolean) => React.ReactNode }) {
  const goPrev = () => onSelect(selectedIndex === 0 ? items.length - 1 : selectedIndex - 1);
  const goNext = () => onSelect(selectedIndex === items.length - 1 ? 0 : selectedIndex + 1);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">{label}</span>
        <span className="text-[10px] text-muted-foreground">{items[selectedIndex].name}</span>
      </div>
      <div className="flex items-center gap-1">
        <button onClick={goPrev} type="button" className="w-7 h-7 rounded-full border hover:bg-muted flex items-center justify-center shrink-0">
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="flex flex-nowrap gap-1 py-0.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
            {items.map((item, i) => (
              <button key={item.id} onClick={() => onSelect(i)} type="button" className="shrink-0">
                {renderItem(item, i === selectedIndex)}
              </button>
            ))}
          </div>
        </div>
        <button onClick={goNext} type="button" className="w-7 h-7 rounded-full border hover:bg-muted flex items-center justify-center shrink-0">
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function IntensitySlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <span className="text-[10px] text-muted-foreground w-14 shrink-0">{label}</span>
      <input type="range" min={0} max={200} value={Math.round(value * 100)}
        onChange={e => onChange(parseInt(e.target.value) / 100)}
        className="flex-1 h-1.5 accent-primary cursor-pointer" />
      <span className="text-[10px] text-muted-foreground w-8 text-right">{Math.round(value * 100)}%</span>
    </div>
  );
}

function Preview({ name, style }: { name: string; style: SiteNameStyle }) {
  const cssStyle = useMemo((): CSSProperties => {
    const base: CSSProperties = {
      fontFamily: `"${style.fontFamily}", sans-serif`, fontSize: '2rem',
      fontWeight: style.fontWeight, letterSpacing: style.letterSpacing,
      textTransform: style.textTransform as CSSProperties['textTransform'],
      textShadow: style.textShadow === 'none' ? undefined : style.textShadow,
      lineHeight: 1.2, WebkitTextStroke: style.textStroke || 'unset',
      transform: style.transform || undefined, display: 'inline-block',
      backfaceVisibility: 'hidden',
    };
    if (style.gradient?.enabled) {
      return { ...base, color: 'transparent',
        backgroundImage: `linear-gradient(${style.gradient.direction}, ${style.gradient.from}, ${style.gradient.to})`,
        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' };
    }
    return { ...base, color: style.color, backgroundImage: 'none',
      WebkitBackgroundClip: 'initial', WebkitTextFillColor: style.color, backgroundClip: 'initial' };
  }, [style]);
  // Imperatively enforce background-clip after every render — React's style reconciliation
  // skips re-applying backgroundClip when switching between gradient colours because the
  // value doesn't change ('text' → 'text'), but the browser resets it internally.
  const spanRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = spanRef.current;
    if (el && style.gradient?.enabled) {
      el.style.backgroundClip = 'text';
      el.style.setProperty('-webkit-background-clip', 'text');
    }
  });
  return <span ref={spanRef} style={cssStyle}>{name || 'YouEye'}</span>;
}

interface Props {
  siteName: string;
  initialStyle?: SiteNameStyle | null;
  onChange: (style: SiteNameStyle) => void;
  /** Show as compact card for settings pages */
  compact?: boolean;
}

function findInitialIndices(s: SiteNameStyle | null | undefined) {
  if (!s) return { font: 0, effect: 0, colour: 0, shape: 0 };
  const font = s.fontFamily ? FONT_PRESETS.findIndex(p => p.fontFamily === s.fontFamily) : -1;
  const colour = (() => {
    if (s.gradient?.enabled) {
      const i = COLOUR_PRESETS.findIndex(p => p.gradient?.enabled && p.gradient.from === s.gradient!.from && p.gradient.to === s.gradient!.to);
      if (i >= 0) return i;
    }
    if (s.color) {
      const i = COLOUR_PRESETS.findIndex(p => p.color.toLowerCase() === s.color!.toLowerCase());
      if (i >= 0) return i;
    }
    return -1;
  })();
  const effect = (() => {
    if (s.textStroke) return EFFECT_PRESETS.findIndex(p => p.id === 'outline');
    if (!s.textShadow || s.textShadow === 'none') return 0;
    // Match by structure similarity — strip numbers and compare pattern
    const normalize = (ts: string) => ts.replace(/[\d.]+/g, '#').replace(/\s+/g, ' ');
    const target = normalize(s.textShadow);
    const i = EFFECT_PRESETS.findIndex(p => p.textShadow !== 'none' && normalize(p.textShadow) === target);
    return i >= 0 ? i : -1;
  })();
  const shape = (() => {
    if (!s.transform) return 0;
    // Match by transform function type (skewX, scaleX, perspective, etc.)
    const fnType = (t: string) => t.replace(/\([^)]*\)/g, '()').replace(/\s+/g, ' ');
    const target = fnType(s.transform);
    const i = SHAPE_PRESETS.findIndex(p => p.transform !== 'none' && fnType(p.transform) === target);
    return i >= 0 ? i : 0;
  })();
  return { font: Math.max(font, 0), effect: Math.max(effect, 0), colour: Math.max(colour, 0), shape: Math.max(shape, 0) };
}

export default function WordArtPicker({ siteName, initialStyle, onChange, compact = false }: Props) {
  usePreloadFonts();
  const [fontIndex, setFontIndex] = useState(0);
  const [effectIndex, setEffectIndex] = useState(0);
  const [colourIndex, setColourIndex] = useState(0);
  const [shapeIndex, setShapeIndex] = useState(0);
  const [effectIntensity, setEffectIntensity] = useState(1);
  const [shapeIntensity, setShapeIntensity] = useState(1);
  const [userInteracted, setUserInteracted] = useState(false);

  // Sync indices when initialStyle arrives or changes (e.g. from async API fetch).
  // Only sync if the user hasn't manually picked a preset yet.
  const styleFingerprint = initialStyle ? `${initialStyle.fontFamily}|${initialStyle.color}|${initialStyle.gradient?.from}|${initialStyle.textShadow}|${initialStyle.transform}` : '';
  useEffect(() => {
    if (userInteracted || !initialStyle?.fontFamily) return;
    const indices = findInitialIndices(initialStyle);
    setFontIndex(indices.font);
    setEffectIndex(indices.effect);
    setColourIndex(indices.colour);
    setShapeIndex(indices.shape);
  }, [styleFingerprint]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const s = composeStyle(FONT_PRESETS[fontIndex], EFFECT_PRESETS[effectIndex], COLOUR_PRESETS[colourIndex], SHAPE_PRESETS[shapeIndex], effectIntensity, shapeIntensity);
    onChange(s);
  }, [fontIndex, effectIndex, colourIndex, shapeIndex, effectIntensity, shapeIntensity, onChange]);

  const previewStyle = useMemo(() => ({
    ...composeStyle(FONT_PRESETS[fontIndex], EFFECT_PRESETS[effectIndex], COLOUR_PRESETS[colourIndex], SHAPE_PRESETS[shapeIndex], effectIntensity, shapeIntensity),
    fontSize: compact ? '2rem' : '2.4rem',
  }), [fontIndex, effectIndex, colourIndex, shapeIndex, effectIntensity, shapeIntensity, compact]);

  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-gray-950 flex items-center justify-center min-h-[80px] py-6 px-4 overflow-hidden">
        <Preview name={siteName} style={previewStyle} />
      </div>
      <PickerRow label="Font" items={FONT_PRESETS} selectedIndex={fontIndex} onSelect={i => { setUserInteracted(true); setFontIndex(i); }}
        renderItem={(item, sel) => (
          <div className={`w-12 h-8 flex items-center justify-center rounded border text-[10px] transition-all ${sel ? 'border-primary bg-primary/5 shadow-sm' : 'border-border hover:border-muted-foreground/40'}`}
            style={{ fontFamily: `"${item.fontFamily}", sans-serif`, fontWeight: item.fontWeight }}>Aa</div>
        )} />
      <div className="space-y-1">
        <PickerRow label="Effect" items={EFFECT_PRESETS} selectedIndex={effectIndex} onSelect={i => { setUserInteracted(true); setEffectIndex(i); }}
          renderItem={(item, sel) => (
            <div className={`w-12 h-8 flex items-center justify-center rounded text-[10px] font-bold text-white transition-all ${sel ? 'ring-2 ring-primary ring-offset-1' : ''}`}
              style={{ backgroundColor: '#111', textShadow: item.textShadow === 'none' ? undefined : item.textShadow.replace(/currentColor/g, '#fff'),
                WebkitTextStroke: item.textStroke?.replace('currentColor', '#fff'), color: item.id === 'outline' ? 'transparent' : '#fff' }}>Aa</div>
          )} />
        {EFFECT_PRESETS[effectIndex].scalable && <IntensitySlider label="Intensity" value={effectIntensity} onChange={v => { setUserInteracted(true); setEffectIntensity(v); }} />}
      </div>
      <div className="space-y-1">
        <PickerRow label="Shape" items={SHAPE_PRESETS} selectedIndex={shapeIndex} onSelect={i => { setUserInteracted(true); setShapeIndex(i); }}
          renderItem={(item, sel) => (
            <div className={`w-12 h-8 flex items-center justify-center rounded border text-[10px] font-bold transition-all ${sel ? 'border-primary bg-primary/5 shadow-sm' : 'border-border hover:border-muted-foreground/40'}`}>
              <span style={{ display: 'inline-block', transform: item.transform !== 'none' ? item.transform : undefined }}>Aa</span>
            </div>
          )} />
        {SHAPE_PRESETS[shapeIndex].scalable && <IntensitySlider label="Intensity" value={shapeIntensity} onChange={v => { setUserInteracted(true); setShapeIntensity(v); }} />}
      </div>
      <PickerRow label="Colour" items={COLOUR_PRESETS} selectedIndex={colourIndex} onSelect={i => { setUserInteracted(true); setColourIndex(i); }}
        renderItem={(item, sel) => (
          <div className={`w-7 h-7 rounded-full transition-colors ${sel ? 'outline outline-2 outline-primary outline-offset-1' : ''}`}
            style={{ background: item.gradient?.enabled ? `linear-gradient(${item.gradient.direction}, ${item.gradient.from}, ${item.gradient.to})` : item.color,
              border: item.color === '#ffffff' || item.color === '#111111' ? '2px solid #d1d5db' : '2px solid transparent' }} />
        )} />
    </div>
  );
}
