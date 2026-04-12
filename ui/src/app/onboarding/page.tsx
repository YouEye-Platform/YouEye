'use client';

import { useState, useEffect, useMemo, CSSProperties, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ArrowRight, CheckCircle2, Shield } from 'lucide-react';
import { PINPrompt } from '@/components/timeline/pin-prompt';
import { useTranslations } from 'next-intl';

interface SiteNameStyle {
  fontFamily: string;
  fontSize: string;
  fontWeight: number;
  letterSpacing: string;
  color: string;
  gradient: {
    enabled: boolean;
    from: string;
    to: string;
    direction: string;
  } | null;
  textShadow: string;
  textTransform: string;
  textStroke?: string;
  reflection?: {
    enabled: boolean;
    opacity: number;
  };
}

interface BrandingConfig {
  site_name: string;
  site_name_style: SiteNameStyle | null;
}

// Step: 0=welcome, 1=pin, 2=done
type OnboardingStep = 0 | 1 | 2;

/** Load Google Font dynamically */
function useGoogleFont(fontFamily: string | undefined) {
  useEffect(() => {
    if (!fontFamily) return;
    const id = `gf-${fontFamily.replace(/\s+/g, '-')}`;
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontFamily)}:wght@300;400;500;600;700;800;900&display=swap`;
    document.head.appendChild(link);
  }, [fontFamily]);
}

/** WordArt renderer for the welcome screen */
function WordArtDisplay({ name, style }: { name: string; style: SiteNameStyle }) {
  useGoogleFont(style.fontFamily);

  const cssStyle = useMemo((): CSSProperties => {
    const base: CSSProperties = {
      fontFamily: `"${style.fontFamily}", sans-serif`,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      letterSpacing: style.letterSpacing,
      textTransform: style.textTransform as CSSProperties['textTransform'],
      textShadow: style.textShadow === 'none' ? undefined : style.textShadow,
      lineHeight: 1.2,
      WebkitTextStroke: style.textStroke || undefined,
    };
    if (style.gradient?.enabled) {
      return {
        ...base,
        color: 'transparent',
        backgroundImage: `linear-gradient(${style.gradient.direction}, ${style.gradient.from}, ${style.gradient.to})`,
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
      };
    }
    return { ...base, color: style.color, backgroundImage: 'none',
      WebkitBackgroundClip: 'initial', WebkitTextFillColor: style.color, backgroundClip: 'initial' };
  }, [style]);

  const reflectionStyle = useMemo((): CSSProperties => ({
    ...cssStyle,
    transform: 'scaleY(-1)',
    opacity: style.reflection?.opacity ?? 0.2,
    maskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.4) 0%, transparent 70%)',
    WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.4) 0%, transparent 70%)',
    height: '1.5em',
    overflow: 'hidden',
    pointerEvents: 'none',
    userSelect: 'none',
  }), [cssStyle, style.reflection?.opacity]);

  return (
    <div className="flex flex-col items-center">
      <span key={style.gradient?.enabled ? `g-${style.gradient.from}-${style.gradient.to}` : 's'} style={cssStyle}>{name}</span>
      {style.reflection?.enabled && (
        <div style={reflectionStyle} aria-hidden="true">
          {name}
        </div>
      )}
    </div>
  );
}

const DEFAULT_STYLE: SiteNameStyle = {
  fontFamily: 'Inter',
  fontSize: '3rem',
  fontWeight: 700,
  letterSpacing: '0.02em',
  color: '#ffffff',
  gradient: null,
  textShadow: 'none',
  textTransform: 'none',
};

export default function OnboardingPage() {
  const t = useTranslations('onboarding');
  const router = useRouter();
  const [step, setStep] = useState<OnboardingStep>(0);
  const [branding, setBranding] = useState<BrandingConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [transitioning, setTransitioning] = useState(false);

  // Fetch branding config
  useEffect(() => {
    Promise.all([
      fetch('/api/v1/branding').then(r => r.json()).catch(() => null),
      fetch('/api/v1/onboarding').then(r => r.json()).catch(() => ({ completed: false })),
    ]).then(([brandingData, onboardingData]) => {
      if (onboardingData?.completed) {
        router.replace('/');
        return;
      }
      if (brandingData) {
        setBranding(brandingData);
      }
      setLoading(false);
    });
  }, [router]);

  const goToStep = useCallback((next: OnboardingStep) => {
    setTransitioning(true);
    setTimeout(() => {
      setStep(next);
      setTransitioning(false);
    }, 200);
  }, []);

  const handleComplete = useCallback(async () => {
    // Mark onboarding as done
    await fetch('/api/v1/onboarding', { method: 'POST' });
    goToStep(2);
    // Redirect to home after a short delay
    setTimeout(() => {
      router.push('/');
    }, 2000);
  }, [goToStep, router]);

  const handlePinSuccess = useCallback(() => {
    handleComplete();
  }, [handleComplete]);

  const handleSkipPin = useCallback(() => {
    handleComplete();
  }, [handleComplete]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <Loader2 className="h-8 w-8 animate-spin text-white/50" />
      </div>
    );
  }

  const siteName = branding?.site_name || 'YouEye';
  const style = branding?.site_name_style || DEFAULT_STYLE;
  // Make the welcome WordArt larger
  const welcomeStyle = { ...style, fontSize: '3.5rem' };

  const contentClass = transitioning
    ? 'opacity-0 transition-opacity duration-200'
    : 'opacity-100 transition-opacity duration-300';

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
      <div className={`w-full max-w-lg ${contentClass}`}>
        {/* Step 0: Welcome */}
        {step === 0 && (
          <div className="text-center space-y-8 animate-in fade-in zoom-in-95 duration-700">
            <p className="text-white/50 text-sm tracking-wider uppercase animate-in fade-in slide-in-from-bottom-4 duration-500">
              {t('welcomeTo')}
            </p>

            <div className="animate-in fade-in zoom-in-90 duration-700 delay-200">
              <WordArtDisplay name={siteName} style={welcomeStyle} />
            </div>

            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 delay-500">
              <button
                onClick={() => goToStep(1)}
                className="inline-flex items-center gap-2 rounded-xl bg-white/10 hover:bg-white/15 backdrop-blur-sm px-8 py-4 text-white font-medium transition-all hover:scale-105 active:scale-95"
              >
                {t('getStarted')}
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        {/* Step 1: Timeline PIN */}
        {step === 1 && (
          <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-500">
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-white/10 mb-4">
                <Shield className="h-7 w-7 text-white" />
              </div>
              <h2 className="text-2xl font-bold text-white mb-2">{t('createPinTitle')}</h2>
              <p className="text-white/60 text-sm max-w-sm mx-auto">{t('createPinDesc')}</p>
            </div>

            <div className="rounded-2xl bg-white/5 border border-white/10 p-6">
              <PINPrompt
                mode="create"
                onSuccess={handlePinSuccess}
                onCancel={handleSkipPin}
              />
            </div>

            <div className="text-center">
              <button
                onClick={handleSkipPin}
                className="text-sm text-white/40 hover:text-white/60 transition-colors"
              >
                {t('skipForNow')}
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Done */}
        {step === 2 && (
          <div className="text-center space-y-6 animate-in fade-in zoom-in-95 duration-500">
            <div className="animate-in zoom-in-50 duration-300">
              <CheckCircle2 className="h-20 w-20 text-green-500 mx-auto" />
            </div>
            <h2 className="text-2xl font-bold text-white">{t('allSet')}</h2>
            <p className="text-white/50 text-sm">{t('redirecting')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
