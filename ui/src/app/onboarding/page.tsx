'use client';

import { useState, useEffect, useMemo, CSSProperties, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ArrowRight, CheckCircle2, Shield, Camera } from 'lucide-react';
import { PINPrompt } from '@/components/timeline/pin-prompt';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';

import { CHARACTER_SHAPE_PRESETS } from '@/lib/wordart-presets';

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
  charShapeId?: string;
  charShapeIntensity?: number;
  reflection?: {
    enabled: boolean;
    opacity: number;
  };
}

interface BrandingConfig {
  site_name: string;
  site_name_style: SiteNameStyle | null;
}

// Step: 0=welcome, 1=avatar, 2=pin, 3=done
type OnboardingStep = 0 | 1 | 2 | 3;

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
  'Bangers': '/fonts/bangers.css', 'Bebas Neue': '/fonts/bebas-neue.css',
  'Dancing Script': '/fonts/dancing-script.css', 'Comfortaa': '/fonts/comfortaa.css',
  'Oswald': '/fonts/oswald.css', 'Titan One': '/fonts/titan-one.css',
  'Black Ops One': '/fonts/black-ops-one.css', 'Creepster': '/fonts/creepster.css',
  'Monoton': '/fonts/monoton.css', 'Press Start 2P': '/fonts/press-start-2p.css',
  'Audiowide': '/fonts/audiowide.css', 'Cinzel': '/fonts/cinzel.css',
  'Great Vibes': '/fonts/great-vibes.css', 'Quicksand': '/fonts/quicksand.css',
  'Archivo Black': '/fonts/archivo-black.css',
};

function useGoogleFont(fontFamily: string | undefined) {
  useEffect(() => {
    if (!fontFamily) return;
    const id = `gf-${fontFamily.replace(/\s+/g, '-')}`;
    if (document.getElementById(id)) return;
    const cssPath = FONT_CSS_MAP[fontFamily];
    if (!cssPath) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = cssPath;
    document.head.appendChild(link);
  }, [fontFamily]);
}

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

  const charShape = style.charShapeId
    ? CHARACTER_SHAPE_PRESETS.find(p => p.id === style.charShapeId) ?? null
    : null;

  const renderText = () => {
    if (charShape) {
      const intensity = style.charShapeIntensity ?? 1;
      return name.split('').map((ch, i) => (
        <span key={i} style={{ display: 'inline-block', transform: charShape.charTransform(i, name.length, intensity) }}>
          {ch === ' ' ? '\u00A0' : ch}
        </span>
      ));
    }
    return name;
  };

  return (
    <div className="flex flex-col items-center">
      <span key={style.gradient?.enabled ? `g-${style.gradient.from}-${style.gradient.to}` : 's'}
        style={{ ...cssStyle, ...(charShape ? { display: 'inline-flex', alignItems: 'baseline' } : {}) }}>
        {renderText()}
      </span>
      {style.reflection?.enabled && (
        <div style={reflectionStyle} aria-hidden="true">
          {renderText()}
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

function getAvatarEmbedUrl(theme: string): string {
  const cpBase = typeof window !== 'undefined'
    ? `${window.location.protocol}//control.${window.location.host}`
    : 'https://control.devvm.test';
  return `${cpBase}/embed/avatar?theme=${theme}`;
}

export default function OnboardingPage() {
  const t = useTranslations('onboarding');
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const [step, setStep] = useState<OnboardingStep>(0);
  const [branding, setBranding] = useState<BrandingConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [transitioning, setTransitioning] = useState(false);
  const [avatarSet, setAvatarSet] = useState(false);
  const avatarEmbedRef = useRef<HTMLIFrameElement>(null);
  const [avatarEmbedReady, setAvatarEmbedReady] = useState(false);
  const [avatarEmbedHeight, setAvatarEmbedHeight] = useState(280);

  const isDark = resolvedTheme === 'dark';
  const theme = resolvedTheme || 'system';

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

  // Listen for avatar embed messages
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === 'youeye-embed-ready' || e.data?.type === 'youeye-embed-resize') {
        setAvatarEmbedReady(true);
        // Send theme to embed
        if (avatarEmbedRef.current?.contentWindow) {
          avatarEmbedRef.current.contentWindow.postMessage(
            { type: 'youeye-embed-theme', theme: resolvedTheme || 'dark' },
            '*'
          );
        }
      }
      if (e.data?.type === 'youeye-embed-resize' && typeof e.data.height === 'number') {
        setAvatarEmbedHeight(Math.max(e.data.height, 200));
      }
      if (e.data?.type === 'youeye-avatar-updated' && e.data.dataUrl) {
        setAvatarSet(true);
        // Save avatar locally on UI side
        fetch(e.data.dataUrl)
          .then(r => r.blob())
          .then(blob => {
            const formData = new FormData();
            formData.append('file', blob, 'avatar.png');
            return fetch('/api/v1/user/avatar', { method: 'POST', body: formData });
          })
          .catch(() => {});
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [resolvedTheme]);

  // Send theme updates to avatar embed
  useEffect(() => {
    if (avatarEmbedReady && avatarEmbedRef.current?.contentWindow) {
      avatarEmbedRef.current.contentWindow.postMessage(
        { type: 'youeye-embed-theme', theme: resolvedTheme || 'dark' },
        '*'
      );
    }
  }, [resolvedTheme, avatarEmbedReady]);

  const goToStep = useCallback((next: OnboardingStep) => {
    setTransitioning(true);
    setTimeout(() => {
      setStep(next);
      setTransitioning(false);
    }, 200);
  }, []);

  const handleComplete = useCallback(async () => {
    await fetch('/api/v1/onboarding', { method: 'POST' });
    goToStep(3);
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
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const siteName = branding?.site_name || 'YouEye';
  const style = branding?.site_name_style || DEFAULT_STYLE;
  const welcomeStyle = { ...style, fontSize: '3.5rem' };

  const contentClass = transitioning
    ? 'opacity-0 transition-opacity duration-200'
    : 'opacity-100 transition-opacity duration-300';

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className={`w-full max-w-lg ${contentClass}`}>
        {/* Step 0: Welcome */}
        {step === 0 && (
          <div className="text-center space-y-8 animate-in fade-in zoom-in-95 duration-700">
            <p className="text-muted-foreground text-sm tracking-wider uppercase animate-in fade-in slide-in-from-bottom-4 duration-500">
              {t('welcomeTo')}
            </p>

            <div className="animate-in fade-in zoom-in-90 duration-700 delay-200">
              <WordArtDisplay name={siteName} style={welcomeStyle} />
            </div>

            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 delay-500">
              <button
                onClick={() => goToStep(1)}
                className="inline-flex items-center gap-2 rounded-xl bg-primary/10 hover:bg-primary/15 backdrop-blur-sm px-8 py-4 text-foreground font-medium transition-all hover:scale-105 active:scale-95 border border-border"
              >
                {t('getStarted')}
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        {/* Step 1: Avatar */}
        {step === 1 && (
          <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-500">
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 mb-4">
                <Camera className="h-7 w-7 text-foreground" />
              </div>
              <h2 className="text-2xl font-bold text-foreground mb-2">{t('chooseAvatarTitle')}</h2>
              <p className="text-muted-foreground text-sm max-w-sm mx-auto">{t('chooseAvatarDesc')}</p>
            </div>

            <div className="rounded-2xl bg-muted/30 border border-border overflow-hidden">
              {!avatarEmbedReady && (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              )}
              <iframe
                ref={avatarEmbedRef}
                src={getAvatarEmbedUrl(theme)}
                title="Choose Avatar"
                sandbox="allow-scripts allow-same-origin allow-forms"
                style={{
                  width: '100%',
                  height: avatarEmbedHeight,
                  border: 'none',
                  display: avatarEmbedReady ? 'block' : 'none',
                }}
              />
            </div>

            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => goToStep(2)}
                className="inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-primary-foreground font-medium transition-all hover:bg-primary/90"
              >
                {avatarSet ? t('continue') : t('continue')}
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>

            <div className="text-center">
              <button
                onClick={() => goToStep(2)}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {t('skipForNow')}
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Timeline PIN */}
        {step === 2 && (
          <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-500">
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 mb-4">
                <Shield className="h-7 w-7 text-foreground" />
              </div>
              <h2 className="text-2xl font-bold text-foreground mb-2">{t('createPinTitle')}</h2>
              <p className="text-muted-foreground text-sm max-w-sm mx-auto">{t('createPinDesc')}</p>
            </div>

            <div className="rounded-2xl bg-muted/30 border border-border p-6">
              <PINPrompt
                mode="create"
                embedded
                onSuccess={handlePinSuccess}
                onCancel={handleSkipPin}
              />
            </div>

            <div className="text-center">
              <button
                onClick={handleSkipPin}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {t('skipForNow')}
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Done */}
        {step === 3 && (
          <div className="text-center space-y-6 animate-in fade-in zoom-in-95 duration-500">
            <div className="animate-in zoom-in-50 duration-300">
              <CheckCircle2 className="h-20 w-20 text-green-500 mx-auto" />
            </div>
            <h2 className="text-2xl font-bold text-foreground">{t('allSet')}</h2>
            <p className="text-muted-foreground text-sm">{t('redirecting')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
