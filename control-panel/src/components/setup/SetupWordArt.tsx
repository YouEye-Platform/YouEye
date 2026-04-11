'use client';

import { useState, useEffect, useMemo } from 'react';
import { ChevronLeft, ChevronRight, ArrowRight, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  type SiteNameStyle,
  FONT_PRESETS,
  EFFECT_PRESETS,
  COLOUR_PRESETS,
  SHAPE_PRESETS,
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

function PickerRow<T extends { id: string; name: string }>({
  label,
  items,
  selectedIndex,
  onSelect,
  renderItem,
}: {
  label: string;
  items: T[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  renderItem: (item: T, selected: boolean) => React.ReactNode;
}) {
  const goPrev = () => onSelect(selectedIndex === 0 ? items.length - 1 : selectedIndex - 1);
  const goNext = () => onSelect(selectedIndex === items.length - 1 ? 0 : selectedIndex + 1);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">{label}</span>
        <span className="text-[10px] text-muted-foreground">{items[selectedIndex].name}</span>
      </div>
      <div className="flex items-center gap-1">
        <button onClick={goPrev} type="button"
          className="w-7 h-7 rounded-full border hover:bg-muted flex items-center justify-center shrink-0">
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
        <button onClick={goNext} type="button"
          className="w-7 h-7 rounded-full border hover:bg-muted flex items-center justify-center shrink-0">
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
      SHAPE_PRESETS[shapeIndex],
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
      <PickerRow label={t('fontLabel')} items={FONT_PRESETS} selectedIndex={fontIndex} onSelect={setFontIndex}
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
        <PickerRow label={t('effectLabel')} items={EFFECT_PRESETS} selectedIndex={effectIndex} onSelect={setEffectIndex}
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
        <PickerRow label={t('shapeLabel')} items={SHAPE_PRESETS} selectedIndex={shapeIndex} onSelect={setShapeIndex}
          renderItem={(item, sel) => (
            <div className={`w-12 h-8 flex items-center justify-center rounded border text-[10px] font-bold transition-all ${
              sel ? 'border-primary bg-primary/5 shadow-sm' : 'border-border hover:border-muted-foreground/40'
            }`}>
              <span style={{ display: 'inline-block', transform: item.transform !== 'none' ? item.transform : undefined }}>Aa</span>
            </div>
          )}
        />
        {SHAPE_PRESETS[shapeIndex].scalable && (
          <IntensitySlider label={t('intensity')} value={shapeIntensity} onChange={setShapeIntensity} />
        )}
      </div>

      {/* Colour */}
      <PickerRow label={t('colourLabel')} items={COLOUR_PRESETS} selectedIndex={colourIndex} onSelect={setColourIndex}
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
