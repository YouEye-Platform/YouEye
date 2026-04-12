'use client';

import { useState, useEffect, useRef, useMemo, CSSProperties } from 'react';
import type { SiteNameStyle } from '@/lib/db/queries/branding';
import {
  FONT_PRESETS, EFFECT_PRESETS, COLOUR_PRESETS, SHAPE_PRESETS,
  ALL_SHAPE_PRESETS, CHARACTER_SHAPE_PRESETS,
  composeStyle, isCharacterShape,
  type AnyShapePreset, type CharacterShapePreset,
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
  // New fonts
  'Bangers': '/fonts/bangers.css', 'Bebas Neue': '/fonts/bebas-neue.css',
  'Dancing Script': '/fonts/dancing-script.css', 'Comfortaa': '/fonts/comfortaa.css',
  'Oswald': '/fonts/oswald.css', 'Titan One': '/fonts/titan-one.css',
  'Black Ops One': '/fonts/black-ops-one.css', 'Creepster': '/fonts/creepster.css',
  'Monoton': '/fonts/monoton.css', 'Press Start 2P': '/fonts/press-start-2p.css',
  'Audiowide': '/fonts/audiowide.css', 'Cinzel': '/fonts/cinzel.css',
  'Great Vibes': '/fonts/great-vibes.css', 'Quicksand': '/fonts/quicksand.css',
  'Archivo Black': '/fonts/archivo-black.css',
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

function ExpandableSection<T extends { id: string; name: string }>({
  label, items, selectedIndex, onSelect, renderItem, previewCount = 6,
}: {
  label: string; items: T[]; selectedIndex: number; onSelect: (i: number) => void;
  renderItem: (item: T, sel: boolean) => React.ReactNode; previewCount?: number;
}) {
  const [open, setOpen] = useState(false);
  const overflow = Math.max(0, items.length - previewCount);

  // Collapsed: show first N items, but always include the selected one
  const previewIndices = useMemo(() => {
    const count = Math.min(previewCount, items.length);
    const indices: number[] = [];
    for (let i = 0; i < count; i++) indices.push(i);
    if (selectedIndex >= count) indices[count - 1] = selectedIndex;
    return indices;
  }, [selectedIndex, previewCount, items.length]);

  const extraIndices = useMemo(() => {
    const shown = new Set(previewIndices);
    return items.map((_, i) => i).filter(i => !shown.has(i));
  }, [previewIndices, items.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div className="flex items-center justify-between px-1 mb-1.5">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">{label}</span>
        <span className="text-[10px] text-muted-foreground">{items[selectedIndex].name}</span>
      </div>
      <div className="flex items-center gap-1.5">
        {previewIndices.map(i => (
          <button key={items[i].id} onClick={() => onSelect(i)} type="button" className="shrink-0">
            {renderItem(items[i], i === selectedIndex)}
          </button>
        ))}
        {overflow > 0 && (
          <button type="button" onClick={() => setOpen(!open)}
            className={`shrink-0 h-8 px-2.5 rounded-md text-[10px] font-medium transition-all duration-200 ${
              open
                ? 'bg-primary/10 text-primary border border-primary/20'
                : 'border border-dashed border-muted-foreground/25 text-muted-foreground/60 hover:text-muted-foreground hover:border-muted-foreground/40'
            }`}>
            {open ? 'Less' : `+${overflow}`}
          </button>
        )}
      </div>
      {overflow > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateRows: open ? '1fr' : '0fr',
          transition: 'grid-template-rows 250ms cubic-bezier(0.4, 0, 0.2, 1)',
        }}>
          <div style={{ overflow: 'hidden' }}>
            <div className="flex flex-wrap gap-1.5 pt-2">
              {extraIndices.map((i, arrIdx) => (
                <button key={items[i].id}
                  onClick={() => onSelect(i)}
                  type="button" className="shrink-0"
                  style={{
                    opacity: open ? 1 : 0,
                    transform: open ? 'scale(1)' : 'scale(0.92)',
                    transition: `opacity 200ms ease ${Math.min(arrIdx * 12, 150)}ms, transform 200ms ease ${Math.min(arrIdx * 12, 150)}ms`,
                  }}>
                  {renderItem(items[i], i === selectedIndex)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
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
  const charShape = style.charShapeId
    ? CHARACTER_SHAPE_PRESETS.find(s => s.id === style.charShapeId) ?? null
    : null;
  const text = name || 'YouEye';

  const baseStyle = useMemo((): CSSProperties => {
    const base: CSSProperties = {
      fontFamily: `"${style.fontFamily}", sans-serif`, fontSize: '2rem',
      fontWeight: style.fontWeight, letterSpacing: style.letterSpacing,
      textTransform: style.textTransform as CSSProperties['textTransform'],
      textShadow: style.textShadow === 'none' ? undefined : style.textShadow,
      lineHeight: 1.2, WebkitTextStroke: style.textStroke || 'unset',
      transform: charShape ? undefined : (style.transform || undefined),
      display: 'inline-block',
      backfaceVisibility: 'hidden',
    };
    if (style.gradient?.enabled) {
      return { ...base, color: 'transparent',
        backgroundImage: `linear-gradient(${style.gradient.direction}, ${style.gradient.from}, ${style.gradient.to})`,
        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' };
    }
    return { ...base, color: style.color, backgroundImage: 'none',
      WebkitBackgroundClip: 'initial', WebkitTextFillColor: style.color, backgroundClip: 'initial' };
  }, [style, charShape]);

  const spanRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = spanRef.current;
    if (el && style.gradient?.enabled) {
      el.style.backgroundClip = 'text';
      el.style.setProperty('-webkit-background-clip', 'text');
    }
  });

  if (charShape) {
    const intensity = style.charShapeIntensity ?? 1;
    return (
      <span ref={spanRef} style={{ ...baseStyle, display: 'inline-flex', alignItems: 'baseline' }}>
        {text.split('').map((ch, i) => (
          <span key={i} style={{ display: 'inline-block', transform: charShape.charTransform(i, text.length, intensity) }}>
            {ch === ' ' ? '\u00A0' : ch}
          </span>
        ))}
      </span>
    );
  }
  return <span ref={spanRef} style={baseStyle}>{text}</span>;
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
    // Check for per-character shape first
    if (s.charShapeId) {
      const i = ALL_SHAPE_PRESETS.findIndex(p => p.id === s.charShapeId);
      if (i >= 0) return i;
    }
    if (!s.transform) return 0;
    // Match by transform function type (skewX, scaleX, perspective, etc.)
    const fnType = (t: string) => t.replace(/\([^)]*\)/g, '()').replace(/\s+/g, ' ');
    const target = fnType(s.transform);
    const i = ALL_SHAPE_PRESETS.findIndex(p => !isCharacterShape(p) && (p as any).transform !== 'none' && fnType((p as any).transform) === target);
    return i >= 0 ? i : 0;
  })();
  return { font: Math.max(font, 0), effect: Math.max(effect, 0), colour: Math.max(colour, 0), shape: Math.max(shape, 0) };
}

export default function WordArtPicker({ siteName, initialStyle, onChange, compact = false }: Props) {
  usePreloadFonts();
  const initIndices = useMemo(() => findInitialIndices(initialStyle), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [fontIndex, setFontIndex] = useState(initIndices.font);
  const [effectIndex, setEffectIndex] = useState(initIndices.effect);
  const [colourIndex, setColourIndex] = useState(initIndices.colour);
  const [shapeIndex, setShapeIndex] = useState(initIndices.shape);
  const [effectIntensity, setEffectIntensity] = useState(1);
  const [shapeIntensity, setShapeIntensity] = useState(1);
  const mountedRef = useRef(false);

  useEffect(() => {
    // Skip the very first render — indices already match initialStyle
    if (!mountedRef.current) { mountedRef.current = true; return; }
    const s = composeStyle(FONT_PRESETS[fontIndex], EFFECT_PRESETS[effectIndex], COLOUR_PRESETS[colourIndex], ALL_SHAPE_PRESETS[shapeIndex], effectIntensity, shapeIntensity);
    onChange(s);
  }, [fontIndex, effectIndex, colourIndex, shapeIndex, effectIntensity, shapeIntensity, onChange]);

  const previewStyle = useMemo(() => ({
    ...composeStyle(FONT_PRESETS[fontIndex], EFFECT_PRESETS[effectIndex], COLOUR_PRESETS[colourIndex], ALL_SHAPE_PRESETS[shapeIndex], effectIntensity, shapeIntensity),
    fontSize: compact ? '2rem' : '2.4rem',
  }), [fontIndex, effectIndex, colourIndex, shapeIndex, effectIntensity, shapeIntensity, compact]);

  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-gray-950 flex items-center justify-center min-h-[80px] py-6 px-4 overflow-hidden">
        <Preview name={siteName} style={previewStyle} />
      </div>
      <ExpandableSection label="Font" items={FONT_PRESETS} selectedIndex={fontIndex} previewCount={6}
        onSelect={i => { setFontIndex(i); }}
        renderItem={(item, sel) => (
          <div className={`w-12 h-8 flex items-center justify-center rounded border text-[10px] transition-all ${sel ? 'border-primary bg-primary/5 shadow-sm' : 'border-border hover:border-muted-foreground/40'}`}
            style={{ fontFamily: `"${item.fontFamily}", sans-serif`, fontWeight: item.fontWeight }}>Aa</div>
        )} />
      <div className="space-y-1">
        <ExpandableSection label="Effect" items={EFFECT_PRESETS} selectedIndex={effectIndex} previewCount={6}
          onSelect={i => { setEffectIndex(i); }}
          renderItem={(item, sel) => (
            <div className={`w-12 h-8 flex items-center justify-center rounded text-[10px] font-bold text-white transition-all ${sel ? 'ring-2 ring-primary ring-offset-1' : ''}`}
              style={{ backgroundColor: '#111', textShadow: item.textShadow === 'none' ? undefined : item.textShadow.replace(/currentColor/g, '#fff'),
                WebkitTextStroke: item.textStroke?.replace('currentColor', '#fff'), color: item.id === 'outline' ? 'transparent' : '#fff' }}>Aa</div>
          )} />
        {EFFECT_PRESETS[effectIndex].scalable && <IntensitySlider label="Intensity" value={effectIntensity} onChange={v => { setEffectIntensity(v); }} />}
      </div>
      <div className="space-y-1">
        <ExpandableSection label="Shape" items={ALL_SHAPE_PRESETS} selectedIndex={shapeIndex} previewCount={6}
          onSelect={i => { setShapeIndex(i); }}
          renderItem={(item, sel) => (
            <div className={`w-12 h-8 flex items-center justify-center rounded border text-[10px] font-bold transition-all ${sel ? 'border-primary bg-primary/5 shadow-sm' : 'border-border hover:border-muted-foreground/40'}`}>
              {isCharacterShape(item) ? (
                <span style={{ display: 'inline-flex', alignItems: 'baseline', fontSize: '8px' }}>
                  {'Aa'.split('').map((ch, i) => (
                    <span key={i} style={{ display: 'inline-block', transform: item.charTransform(i, 2, 1) }}>{ch}</span>
                  ))}
                </span>
              ) : (
                <span style={{ display: 'inline-block', transform: item.transform !== 'none' ? item.transform : undefined }}>Aa</span>
              )}
            </div>
          )} />
        {ALL_SHAPE_PRESETS[shapeIndex].scalable && <IntensitySlider label="Intensity" value={shapeIntensity} onChange={v => { setShapeIntensity(v); }} />}
      </div>
      <ExpandableSection label="Colour" items={COLOUR_PRESETS} selectedIndex={colourIndex} previewCount={8}
        onSelect={i => { setColourIndex(i); }}
        renderItem={(item, sel) => (
          <div className={`w-7 h-7 rounded-full transition-colors ${sel ? 'outline outline-2 outline-primary outline-offset-1' : ''}`}
            style={{ background: item.gradient?.enabled ? `linear-gradient(${item.gradient.direction}, ${item.gradient.from}, ${item.gradient.to})` : item.color,
              border: item.color === '#ffffff' || item.color === '#111111' ? '2px solid #d1d5db' : '2px solid transparent' }} />
        )} />
    </div>
  );
}
