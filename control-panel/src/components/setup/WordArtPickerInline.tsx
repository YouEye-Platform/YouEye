'use client';

/**
 * Inline WordArt Picker — for use in settings pages.
 * Same as SetupWordArt but without nav buttons or page header.
 */

import { useState, useEffect, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  type SiteNameStyle,
  FONT_PRESETS, EFFECT_PRESETS, COLOUR_PRESETS,
  ALL_SHAPE_PRESETS, isCharacterShape,
  composeStyle,
} from '@/lib/wordart-presets';
import WordArtPreview, { usePreloadAllFonts } from './WordArtPreview';

interface Props {
  siteName: string;
  style: SiteNameStyle;
  setStyle: (s: SiteNameStyle) => void;
}

function PickerRow<T extends { id: string; name: string }>({
  label, items, selectedIndex, onSelect, renderItem,
}: { label: string; items: T[]; selectedIndex: number; onSelect: (i: number) => void; renderItem: (item: T, sel: boolean) => React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">{label}</span>
        <span className="text-[10px] text-muted-foreground">{items[selectedIndex].name}</span>
      </div>
      <div className="flex items-center gap-1">
        <button onClick={() => onSelect(selectedIndex === 0 ? items.length - 1 : selectedIndex - 1)} type="button"
          className="w-6 h-6 rounded-full border hover:bg-muted flex items-center justify-center shrink-0">
          <ChevronLeft className="h-3 w-3" />
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
        <button onClick={() => onSelect(selectedIndex === items.length - 1 ? 0 : selectedIndex + 1)} type="button"
          className="w-6 h-6 rounded-full border hover:bg-muted flex items-center justify-center shrink-0">
          <ChevronRight className="h-3 w-3" />
        </button>
      </div>
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
  const [fontIdx, setFontIdx] = useState(0);
  const [effectIdx, setEffectIdx] = useState(0);
  const [colourIdx, setColourIdx] = useState(0);
  const [shapeIdx, setShapeIdx] = useState(0);
  const [effectInt, setEffectInt] = useState(1);
  const [shapeInt, setShapeInt] = useState(1);

  useEffect(() => {
    setStyle(composeStyle(FONT_PRESETS[fontIdx], EFFECT_PRESETS[effectIdx], COLOUR_PRESETS[colourIdx], ALL_SHAPE_PRESETS[shapeIdx], effectInt, shapeInt));
  }, [fontIdx, effectIdx, colourIdx, shapeIdx, effectInt, shapeInt, setStyle]);

  const preview = useMemo(() => ({ ...style, fontSize: '2rem' }), [style]);

  return (
    <div className="space-y-2">
      <div className="rounded-lg bg-gray-950 flex items-center justify-center min-h-[60px] py-4 px-4 overflow-hidden">
        <WordArtPreview name={siteName || 'YouEye'} style={preview} className="transition-all duration-300" />
      </div>
      <PickerRow label="Font" items={FONT_PRESETS} selectedIndex={fontIdx} onSelect={setFontIdx}
        renderItem={(item, sel) => (
          <div className={`w-10 h-7 flex items-center justify-center rounded border text-[9px] transition-all ${sel ? 'border-primary bg-primary/5' : 'border-border'}`}
            style={{ fontFamily: `"${item.fontFamily}", sans-serif`, fontWeight: item.fontWeight }}>Aa</div>
        )} />
      <div className="space-y-1">
        <PickerRow label="Effect" items={EFFECT_PRESETS} selectedIndex={effectIdx} onSelect={setEffectIdx}
          renderItem={(item, sel) => (
            <div className={`w-10 h-7 flex items-center justify-center rounded text-[9px] font-bold text-white transition-all ${sel ? 'ring-2 ring-primary ring-offset-1' : ''}`}
              style={{ backgroundColor: '#111', textShadow: item.textShadow === 'none' ? undefined : item.textShadow.replace(/currentColor/g, '#fff'),
                WebkitTextStroke: item.textStroke?.replace('currentColor', '#fff'), color: item.id === 'outline' ? 'transparent' : '#fff' }}>Aa</div>
          )} />
        {EFFECT_PRESETS[effectIdx].scalable && <IntensitySlider value={effectInt} onChange={setEffectInt} />}
      </div>
      <div className="space-y-1">
        <PickerRow label="Shape" items={ALL_SHAPE_PRESETS} selectedIndex={shapeIdx} onSelect={setShapeIdx}
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
      <PickerRow label="Colour" items={COLOUR_PRESETS} selectedIndex={colourIdx} onSelect={setColourIdx}
        renderItem={(item, sel) => (
          <div className={`w-6 h-6 rounded-full transition-colors ${sel ? 'outline outline-2 outline-primary outline-offset-1' : ''}`}
            style={{ background: item.gradient?.enabled ? `linear-gradient(${item.gradient.direction}, ${item.gradient.from}, ${item.gradient.to})` : item.color,
              border: item.color === '#ffffff' || item.color === '#111111' ? '2px solid #d1d5db' : '2px solid transparent' }} />
        )} />
    </div>
  );
}
