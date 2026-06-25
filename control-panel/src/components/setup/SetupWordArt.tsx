'use client';

import { useState, useEffect, useMemo } from 'react';
import { ArrowRight, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  type SiteNameStyle,
  FONT_PRESETS,
  EFFECT_PRESETS,
  COLOUR_PRESETS,
  ALL_SHAPE_PRESETS,
  isCharacterShape,
  composeStyle,
} from '@/lib/wordart-presets';
import WordArtPreview, { usePreloadAllFonts } from './WordArtPreview';
import { useTranslations } from 'next-intl';

interface Props {
  siteName: string;
  style: SiteNameStyle;
  setStyle: (s: SiteNameStyle) => void;
  onNext: () => void;
  onBack: () => void;
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
              className={`shrink-0 h-8 px-2.5 rounded-md text-[10px] font-medium transition-all duration-200 ${
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

function IntensitySlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <span className="text-[10px] text-muted-foreground w-14 shrink-0">{label}</span>
      <input
        type="range"
        min={0}
        max={200}
        value={Math.round(value * 100)}
        onChange={e => onChange(parseInt(e.target.value) / 100)}
        className="flex-1 h-1.5 accent-primary cursor-pointer"
      />
      <span className="text-[10px] text-muted-foreground w-8 text-right">{Math.round(value * 100)}%</span>
    </div>
  );
}

export default function SetupWordArt({ siteName, style, setStyle, onNext, onBack }: Props) {
  const t = useTranslations('setup');
  usePreloadAllFonts();

  const [fontIndex, setFontIndex] = useState(0);
  const [effectIndex, setEffectIndex] = useState(0);
  const [colourIndex, setColourIndex] = useState(0);
  const [shapeIndex, setShapeIndex] = useState(0);
  const [effectIntensity, setEffectIntensity] = useState(1);
  const [shapeIntensity, setShapeIntensity] = useState(1);

  useEffect(() => {
    const s = composeStyle(
      FONT_PRESETS[fontIndex],
      EFFECT_PRESETS[effectIndex],
      COLOUR_PRESETS[colourIndex],
      ALL_SHAPE_PRESETS[shapeIndex],
      effectIntensity,
      shapeIntensity,
    );
    setStyle(s);
  }, [fontIndex, effectIndex, colourIndex, shapeIndex, effectIntensity, shapeIntensity, setStyle]);

  const previewStyle = useMemo(() => ({ ...style, fontSize: '2.8rem' }), [style]);

  return (
    <div className="w-full max-w-lg mx-auto space-y-3">
      <div className="text-center">
        <h1 className="text-2xl font-bold mb-1">{t('chooseStyle')}</h1>
        <p className="text-muted-foreground text-sm">{t('chooseStyleDesc')}</p>
      </div>

      {/* Live Preview */}
      <div className="rounded-2xl bg-gray-950 flex items-center justify-center min-h-[90px] py-7 px-6 overflow-hidden">
        <WordArtPreview name={siteName || 'YouEye'} style={previewStyle} className="transition-all duration-300" />
      </div>

      {/* Font */}
      <ExpandableSection label={t('fontLabel')} items={FONT_PRESETS} selectedIndex={fontIndex} previewCount={6}
        onSelect={setFontIndex}
        renderItem={(item, sel) => (
          <div className={`w-12 h-8 flex items-center justify-center rounded border text-[10px] transition-all ${
            sel ? 'border-primary bg-primary/5 shadow-sm' : 'border-border hover:border-muted-foreground/40'
          }`} style={{ fontFamily: `"${item.fontFamily}", sans-serif`, fontWeight: item.fontWeight }}>
            Aa
          </div>
        )}
      />

      {/* Effect + intensity */}
      <div className="space-y-1">
        <ExpandableSection label={t('effectLabel')} items={EFFECT_PRESETS} selectedIndex={effectIndex} previewCount={6}
          onSelect={setEffectIndex}
          renderItem={(item, sel) => (
            <div className={`w-12 h-8 flex items-center justify-center rounded text-[10px] font-bold text-white transition-all ${
              sel ? 'ring-2 ring-primary ring-offset-1' : ''
            }`} style={{
              backgroundColor: '#111',
              textShadow: item.textShadow === 'none' ? undefined : item.textShadow.replace(/currentColor/g, '#fff'),
              WebkitTextStroke: item.textStroke?.replace('currentColor', '#fff'),
              color: item.id === 'outline' ? 'transparent' : '#fff',
            }}>Aa</div>
          )}
        />
        {EFFECT_PRESETS[effectIndex].scalable && (
          <IntensitySlider label={t('intensity')} value={effectIntensity} onChange={setEffectIntensity} />
        )}
      </div>

      {/* Shape + intensity */}
      <div className="space-y-1">
        <ExpandableSection label={t('shapeLabel')} items={ALL_SHAPE_PRESETS} selectedIndex={shapeIndex} previewCount={6}
          onSelect={setShapeIndex}
          renderItem={(item, sel) => (
            <div className={`w-12 h-8 flex items-center justify-center rounded border text-[10px] font-bold transition-all ${
              sel ? 'border-primary bg-primary/5 shadow-sm' : 'border-border hover:border-muted-foreground/40'
            }`}>
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
          )}
        />
        {ALL_SHAPE_PRESETS[shapeIndex].scalable && (
          <IntensitySlider label={t('intensity')} value={shapeIntensity} onChange={setShapeIntensity} />
        )}
      </div>

      {/* Colour */}
      <ExpandableSection label={t('colourLabel')} items={COLOUR_PRESETS} selectedIndex={colourIndex} previewCount={8}
        onSelect={setColourIndex}
        renderItem={(item, sel) => (
          <div className={`w-7 h-7 rounded-full transition-colors ${
            sel ? 'outline outline-2 outline-primary outline-offset-1' : ''
          }`} style={{
            background: item.gradient?.enabled
              ? `linear-gradient(${item.gradient.direction}, ${item.gradient.from}, ${item.gradient.to})`
              : item.color,
            border: item.color === '#ffffff' || item.color === '#111111' ? '2px solid #d1d5db' : '2px solid transparent',
          }} />
        )}
      />

      {/* Nav */}
      <div className="flex gap-3 pt-1">
        <Button variant="outline" onClick={onBack} className="h-12 px-6" type="button">
          <ArrowLeft className="h-4 w-4 mr-2" />{t('back')}
        </Button>
        <Button onClick={onNext} className="flex-1 h-12 text-base gap-2" type="button">
          {t('continue')}<ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
