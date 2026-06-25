'use client';

/**
 * Inline WordArt Picker — for use in settings pages.
 * Same as SetupWordArt but without nav buttons or page header.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import {
  type SiteNameStyle,
  FONT_PRESETS, EFFECT_PRESETS, COLOUR_PRESETS,
  ALL_SHAPE_PRESETS, isCharacterShape,
  composeStyle,
} from '@/lib/wordart-presets';

/** Reverse-map a SiteNameStyle back to preset indices */
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
    const normalize = (ts: string) => ts.replace(/[\d.]+/g, '#').replace(/\s+/g, ' ');
    const target = normalize(s.textShadow);
    const i = EFFECT_PRESETS.findIndex(p => p.textShadow !== 'none' && normalize(p.textShadow) === target);
    return i >= 0 ? i : -1;
  })();
  const shape = (() => {
    if (s.charShapeId) {
      const i = ALL_SHAPE_PRESETS.findIndex(p => p.id === s.charShapeId);
      if (i >= 0) return i;
    }
    if (!s.transform) return 0;
    const fnType = (t: string) => t.replace(/\([^)]*\)/g, '()').replace(/\s+/g, ' ');
    const target = fnType(s.transform);
    const i = ALL_SHAPE_PRESETS.findIndex(p => !isCharacterShape(p) && (p as any).transform !== 'none' && fnType((p as any).transform) === target);
    return i >= 0 ? i : 0;
  })();
  return { font: Math.max(font, 0), effect: Math.max(effect, 0), colour: Math.max(colour, 0), shape: Math.max(shape, 0) };
}
import WordArtPreview, { usePreloadAllFonts } from './WordArtPreview';

interface Props {
  siteName: string;
  style: SiteNameStyle;
  setStyle: (s: SiteNameStyle) => void;
}

function ExpandableSection<T extends { id: string; name: string }>({
  label, items, selectedIndex, onSelect, renderItem, previewCount = 6,
}: {
  label: string; items: T[]; selectedIndex: number; onSelect: (i: number) => void;
  renderItem: (item: T, sel: boolean) => React.ReactNode; previewCount?: number;
}) {
  const [open, setOpen] = useState(false);
  const overflow = Math.max(0, items.length - previewCount);

  const previewIndices = useMemo(() => {
    const count = Math.min(previewCount, items.length);
    const indices: number[] = [];
    for (let i = 0; i < count; i++) indices.push(i);
    return indices;
  }, [previewCount, items.length]);

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
        {overflow > 0 && (() => {
          const selInOverflow = selectedIndex >= previewCount;
          return (
            <button type="button" onClick={() => setOpen(!open)}
              className={`shrink-0 h-7 px-2 rounded-md text-[9px] font-medium transition-all duration-200 ${
                open
                  ? 'bg-primary/10 text-primary border border-primary/20'
                  : selInOverflow
                    ? 'bg-primary/10 text-primary border border-primary/30'
                    : 'border border-dashed border-muted-foreground/25 text-muted-foreground/60 hover:text-muted-foreground hover:border-muted-foreground/40'
              }`}>
              {open ? 'Less' : selInOverflow ? `✓ +${overflow}` : `+${overflow}`}
            </button>
          );
        })()}
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

function IntensitySlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <span className="text-[10px] text-muted-foreground w-14 shrink-0">Intensity</span>
      <input type="range" min={0} max={200} value={Math.round(value * 100)}
        onChange={e => onChange(parseInt(e.target.value) / 100)}
        className="flex-1 h-1.5 accent-primary cursor-pointer" />
      <span className="text-[10px] text-muted-foreground w-8 text-right">{Math.round(value * 100)}%</span>
    </div>
  );
}

export default function WordArtPickerInline({ siteName, style, setStyle }: Props) {
  usePreloadAllFonts();
  const initIndices = useMemo(() => findInitialIndices(style), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [fontIdx, setFontIdx] = useState(initIndices.font);
  const [effectIdx, setEffectIdx] = useState(initIndices.effect);
  const [colourIdx, setColourIdx] = useState(initIndices.colour);
  const [shapeIdx, setShapeIdx] = useState(initIndices.shape);
  const [effectInt, setEffectInt] = useState(1);
  const [shapeInt, setShapeInt] = useState(1);
  const mountedRef = useRef(false);

  useEffect(() => {
    // Skip first render — indices already match the loaded style
    if (!mountedRef.current) { mountedRef.current = true; return; }
    setStyle(composeStyle(FONT_PRESETS[fontIdx], EFFECT_PRESETS[effectIdx], COLOUR_PRESETS[colourIdx], ALL_SHAPE_PRESETS[shapeIdx], effectInt, shapeInt));
  }, [fontIdx, effectIdx, colourIdx, shapeIdx, effectInt, shapeInt, setStyle]);

  const preview = useMemo(() => ({ ...style, fontSize: '2rem' }), [style]);

  return (
    <div className="space-y-2">
      <div className="rounded-lg bg-gray-950 flex items-center justify-center min-h-[60px] py-4 px-4 overflow-hidden">
        <WordArtPreview name={siteName || 'YouEye'} style={preview} className="transition-all duration-300" />
      </div>
      <ExpandableSection label="Font" items={FONT_PRESETS} selectedIndex={fontIdx} previewCount={7}
        onSelect={setFontIdx}
        renderItem={(item, sel) => (
          <div className={`w-10 h-7 flex items-center justify-center rounded border text-[9px] transition-all ${sel ? 'border-primary bg-primary/5' : 'border-border'}`}
            style={{ fontFamily: `"${item.fontFamily}", sans-serif`, fontWeight: item.fontWeight }}>Aa</div>
        )} />
      <div className="space-y-1">
        <ExpandableSection label="Effect" items={EFFECT_PRESETS} selectedIndex={effectIdx} previewCount={7}
          onSelect={setEffectIdx}
          renderItem={(item, sel) => (
            <div className={`w-10 h-7 flex items-center justify-center rounded text-[9px] font-bold text-white transition-all ${sel ? 'ring-2 ring-primary ring-offset-1' : ''}`}
              style={{ backgroundColor: '#111', textShadow: item.textShadow === 'none' ? undefined : item.textShadow.replace(/currentColor/g, '#fff'),
                WebkitTextStroke: item.textStroke?.replace('currentColor', '#fff'), color: item.id === 'outline' ? 'transparent' : '#fff' }}>Aa</div>
          )} />
        {EFFECT_PRESETS[effectIdx].scalable && <IntensitySlider value={effectInt} onChange={setEffectInt} />}
      </div>
      <div className="space-y-1">
        <ExpandableSection label="Shape" items={ALL_SHAPE_PRESETS} selectedIndex={shapeIdx} previewCount={7}
          onSelect={setShapeIdx}
          renderItem={(item, sel) => (
            <div className={`w-10 h-7 flex items-center justify-center rounded border text-[9px] font-bold transition-all ${sel ? 'border-primary bg-primary/5' : 'border-border'}`}>
              {isCharacterShape(item) ? (
                <span style={{ display: 'inline-flex', alignItems: 'baseline', fontSize: '7px' }}>
                  {'Aa'.split('').map((ch, i) => (
                    <span key={i} style={{ display: 'inline-block', transform: item.charTransform(i, 2, 1) }}>{ch}</span>
                  ))}
                </span>
              ) : (
                <span style={{ display: 'inline-block', transform: item.transform !== 'none' ? item.transform : undefined }}>Aa</span>
              )}
            </div>
          )} />
        {ALL_SHAPE_PRESETS[shapeIdx].scalable && <IntensitySlider value={shapeInt} onChange={setShapeInt} />}
      </div>
      <ExpandableSection label="Colour" items={COLOUR_PRESETS} selectedIndex={colourIdx} previewCount={10}
        onSelect={setColourIdx}
        renderItem={(item, sel) => (
          <div className={`w-6 h-6 rounded-full transition-colors ${sel ? 'outline outline-2 outline-primary outline-offset-1' : ''}`}
            style={{ background: item.gradient?.enabled ? `linear-gradient(${item.gradient.direction}, ${item.gradient.from}, ${item.gradient.to})` : item.color,
              border: item.color === '#ffffff' || item.color === '#111111' ? '2px solid #d1d5db' : '2px solid transparent' }} />
        )} />
    </div>
  );
}
