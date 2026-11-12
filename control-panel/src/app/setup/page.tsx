'use client';
import { useTranslations as useInterfaceTranslations } from "next-intl";


import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  type SiteNameStyle,
  DEFAULT_STYLE,
  TLD_OPTIONS,
} from '@/lib/wordart-presets';

import SetupLanguage from '@/components/setup/SetupLanguage';
import SetupReadiness from '@/components/setup/SetupReadiness';
import SetupChoice from '@/components/setup/SetupChoice';
import SetupRestore from '@/components/setup/SetupRestore';
import SetupServerName, { type TlsChoice } from '@/components/setup/SetupServerName';
import { designSchema } from '@youeye/branding';
import { TitleStudio, initialDesign } from '@youeye/branding/studio';
import { Brand } from '@youeye/branding/brand';
import SetupNamesVerification from '@/components/setup/SetupNamesVerification';
import SetupProvisioning from '@/components/setup/SetupProvisioning';
import SetupTls from '@/components/setup/SetupTls';
import SetupDnsExplainer from '@/components/setup/SetupDnsExplainer';
import { type IconConfig, DEFAULT_ICON_CONFIG } from '@/lib/icon-config';
import { followSetupProgress, readSetupProgress, SetupProgressError } from '@/lib/setup/progress.mjs';
import { useRef as useInterfaceTranslationRef } from "react";

// ─── Types ────────────────────────────────────────────────────

interface SetupConfig {
  site_name: string;
  domain: string;
  subdomains: Record<string, string>;
  setup_completed: boolean;
  tls_choice?: TlsChoice;
  extra?: { tls_choice?: TlsChoice };
}

type StepStatus = 'pending' | 'running' | 'done' | 'error';

interface SetupStep {
  id: string;
  label: string;
  status: StepStatus;
  message?: string;
}

const SETUP_COMPLETE_PATH = '/setup-complete';
const SETUP_RESTART_SETTLE_MS = 2_500;
const SETUP_READY_POLL_MS = 1_000;
const SETUP_READY_MIN_WAIT_MS = 8_000;
const SETUP_READY_TIMEOUT_MS = 45_000;

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Steps: -3=automatic readiness, -2=language, -1=new/restore, 0=serverName(+LE inline), 1=wordart, 2=icon,
//        4=provisioning, 5=tls(upload only), 6=dns
type WizardStep = -3 | -2 | -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 'restore';

// ─── Main Component ──────────────────────────────────────────

export default function SetupPage() {
  const translateInterface = useInterfaceTranslations("interface");
  const interfaceTranslationRef = useInterfaceTranslationRef(translateInterface);
  interfaceTranslationRef.current = translateInterface;

  const t = useTranslations('setup');
  const router = useRouter();
  const [step, setStep] = useState<WizardStep>(-2);
  const [loading, setLoading] = useState(true);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const heading = contentRef.current?.querySelector('h1'); if (heading) { heading.tabIndex = -1; heading.focus(); } }, [step, loading]);
  const [configError, setConfigError] = useState(false);
  const [languageChecked, setLanguageChecked] = useState(false);

  // Step 0: Server name
  const [siteName, setSiteName] = useState('YouEye');
  const [domainSlug, setDomainSlug] = useState('');
  const [tld, setTld] = useState('.local');
  const [subdomains, setSubdomains] = useState({
    control: 'control',
    identity: 'id',
    dns: 'dns',
  });
  const [identityName, setIdentityName] = useState('');
  const [customTld, setCustomTld] = useState('');
  const [tlsChoice, setTlsChoice] = useState<TlsChoice>('youeye-names');
  const [acmeCertIssued, setAcmeCertIssued] = useState(false);
  const [yenName, setYenName] = useState('');
  const [yenFqdn, setYenFqdn] = useState('');
  const [yenTermsVersion, setYenTermsVersion] = useState('');
  const [yenCtAccepted, setYenCtAccepted] = useState(false);
  const [yenClaimProof, setYenClaimProof] = useState('');
  const [yenVerifiedSetup,setYenVerifiedSetup]=useState(false);
  const [yenSetupSession,setYenSetupSession]=useState('');
  useEffect(()=>{setYenClaimProof('');setYenSetupSession('');},[yenName,tlsChoice]);
  const [yenReusing, setYenReusing] = useState(false);
  const [byoDomain, setByoDomain] = useState('');
  const [byoProviderToken, setByoProviderToken] = useState('');

  // Step 1: WordArt
  const [brandingRevision, setBrandingRevision] = useState<string | null>(null);
  const [titleDesign, setTitleDesign] = useState(() => initialDesign('YouEye'));
  const nameStyle: SiteNameStyle = useMemo(() => ({ ...DEFAULT_STYLE, mytitle: { ...titleDesign, name: siteName } }), [titleDesign, siteName]);

  // Step 2: Icon
  const iconConfig: IconConfig = DEFAULT_ICON_CONFIG;

  // Step 4: Provisioning
  const [setupSteps, setSetupSteps] = useState<SetupStep[]>([]);
  const [setupComplete, setSetupComplete] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [setupRestarting, setSetupRestarting] = useState(false);
  const [setupChecking, setSetupChecking] = useState(false);
  const [setupStatusOnlyRetry, setSetupStatusOnlyRetry] = useState(false);
  const setupRequestInFlight = useRef(false);

  // Selected language
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null);

  // Transition state
  const [transitioning, setTransitioning] = useState(false);
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');

  // Check if language was already selected via cookie
  useEffect(() => {
    const hasLanguageCookie = document.cookie.split(';').some(c => c.trim().startsWith('ye-setup-language='));
    if (hasLanguageCookie) {
      const match = document.cookie.match(/ye-setup-language=(\w+)/);
      if (match) setSelectedLanguage(match[1]);
      setStep(-3);
    }
    setLanguageChecked(true);
  }, []);

  async function checkSetupStatus() {
    try {
      const [res, appearance] = await Promise.all([fetch('/api/setup/config', { cache: 'no-store' }), fetch('/api/setup/branding', { cache: 'no-store' })]);
      if (!res.ok) throw new Error(translateInterface("m46a341535604"));
      if (!appearance.ok) throw new Error(translateInterface("ma5bec319c728"));
      const saved = await appearance.json();
      const design = designSchema.safeParse(saved.site_name_style?.mytitle);
      if (saved.site_name_style?.mytitle !== undefined && !design.success) throw new Error(translateInterface("m6e8198402ff4"));
      setBrandingRevision(saved.site_name_style?.mytitleRevision ?? null);
      if (design.success) { setTitleDesign(design.data); setSiteName(design.data.name); }
      setConfigError(false);
      if (res.ok) {
        const config: SetupConfig = await res.json();
        if (config.setup_completed) {
          router.replace(SETUP_COMPLETE_PATH);
          return;
        }
        if (!design.success && config.site_name) setSiteName(config.site_name);
        if (config.domain) {
          const lastDot = config.domain.lastIndexOf('.');
          if (lastDot > 0) {
            const slug = config.domain.slice(0, lastDot);
            const tldPart = '.' + config.domain.slice(lastDot + 1);
            setDomainSlug(slug);
            // Check if this TLD is one of the standard options
            if (TLD_OPTIONS.some(opt => opt.value === tldPart)) {
              setTld(tldPart);
            } else {
              // Custom TLD — set the sentinel and populate customTld
              setTld('__custom__');
              setCustomTld(config.domain.slice(lastDot + 1));
            }
          }
        }
        if (config.subdomains) {
          setSubdomains(prev => ({ ...prev, ...config.subdomains }));
        }
      }
    } catch {
      setConfigError(true);
    }
    setLoading(false);
  }

  useEffect(() => {
    if (languageChecked) checkSetupStatus();
  }, [languageChecked]);

  const navigationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (navigationTimer.current) clearTimeout(navigationTimer.current); }, []);

  // Step navigation with animation
  const goToStep = useCallback((nextStep: WizardStep, dir: 'forward' | 'back' = 'forward') => {
    if (navigationTimer.current) clearTimeout(navigationTimer.current);
    setDirection(dir);
    setTransitioning(true);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    navigationTimer.current = setTimeout(() => {
      setStep(nextStep);
      setTransitioning(false);
      navigationTimer.current = null;
    }, reduced ? 0 : 200);
  }, []);

  const handleReady = useCallback(() => goToStep(-1), [goToStep]);

  // Language selection
  const handleLanguageSelect = useCallback(async (code: string) => {
    setSelectedLanguage(code);
    try {
      await fetch('/api/setup/language', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: code }),
      });
      window.location.reload();
    } catch {
      goToStep(-3);
    }
  }, [goToStep]);

  // Full domain string — resolve custom TLD sentinel
  const effectiveTld = tld === '__custom__' ? (customTld.startsWith('.') ? customTld : `.${customTld}`) : tld;
  const domain = tlsChoice === 'youeye-names' && yenName
    ? yenFqdn
    : tlsChoice === 'byo-provider'
      ? byoDomain.trim().replace(/^https?:\/\//, '').split('/')[0].replace(/\.+$/, '').toLowerCase()
      : `${domainSlug}${effectiveTld}`;

  const waitForControlPanelReady = useCallback(async () => {
    const startedAt = Date.now();
    let sawRestartWindow = false;
    let consecutiveOk = 0;

    await delay(SETUP_RESTART_SETTLE_MS);

    while (Date.now() - startedAt < SETUP_READY_TIMEOUT_MS) {
      try {
        const res = await fetch(`/api/ping?setup-complete-ready=${Date.now()}`, {
          cache: 'no-store',
        });
        if (res.ok) {
          consecutiveOk += 1;
          if (
            consecutiveOk >= 2 &&
            (sawRestartWindow || Date.now() - startedAt >= SETUP_READY_MIN_WAIT_MS)
          ) {
            return;
          }
        } else {
          sawRestartWindow = true;
          consecutiveOk = 0;
        }
      } catch {
        sawRestartWindow = true;
        consecutiveOk = 0;
      }

      await delay(SETUP_READY_POLL_MS);
    }
    throw new Error(interfaceTranslationRef.current("mc71c1a0619bb"));
  }, []);

  // After provisioning completes:
  // - LE/self-signed/YouEye Names: wait for CP's SSO restart, then show DNS explainer
  // - Upload: show upload flow in step 5
  const handleProvisioningComplete = useCallback(() => {
    setSetupError('');
    if (tlsChoice === 'upload') {
      goToStep(5); // show upload flow
    } else {
      setSetupRestarting(true);
      void waitForControlPanelReady().then(() => {
        router.replace(SETUP_COMPLETE_PATH);
      }).catch((cause) => {
        setSetupRestarting(false);
        setSetupStatusOnlyRetry(true);
        setSetupError(cause instanceof Error ? cause.message : interfaceTranslationRef.current("mc71c1a0619bb"));
      });
    }
  }, [tlsChoice, goToStep, router, waitForControlPanelReady]);

  const setupProgressOptions = useCallback(() => ({
    messages: {
      failed: interfaceTranslationRef.current("m386238bd5b5a"),
      unknown: t('setupStatusUnknown'),
    },
    onChecking: setSetupChecking,
    onEvent: (event: { step?: string; status?: StepStatus; message?: string }) => {
      const { step, status, message } = event;
      if (step && status) {
        setSetupSteps(prev => prev.map(item => item.id === step
          ? { ...item, status, ...(message ? { message } : {}) } : item));
      }
    },
  }), [t]);

  const recordSetupFailure = useCallback((error: unknown) => {
    setSetupComplete(false);
    setSetupStatusOnlyRetry(error instanceof SetupProgressError && error.readOnly);
    setSetupError(error instanceof Error ? error.message : interfaceTranslationRef.current("m54d466a16d84"));
  }, []);

  const recordSetupCompletion = useCallback(() => {
    setSetupStatusOnlyRetry(false);
    setSetupSteps(prev => prev.map(item => ({ ...item, status: 'done' })));
    setSetupComplete(true);
  }, []);

  const handleCheckSetupStatus = useCallback(async () => {
    if (setupRequestInFlight.current) return;
    setupRequestInFlight.current = true;
    setSetupError('');
    try {
      await readSetupProgress(setupProgressOptions());
      recordSetupCompletion();
    } catch (error) {
      recordSetupFailure(error);
    } finally {
      setupRequestInFlight.current = false;
    }
  }, [setupProgressOptions, recordSetupCompletion, recordSetupFailure]);

  // Submit once. A lost response is reconciled through retained status reads.
  const handleRunSetup = useCallback(async () => {
    if (setupRequestInFlight.current) return;
    setupRequestInFlight.current = true;
    setSetupError('');
    setSetupComplete(false);
    setSetupStatusOnlyRetry(false);
    const steps: SetupStep[] = [
      { id: 'config', label: t('savingConfig'), status: 'pending' },
      { id: 'caddy', label: t('settingUpProxy'), status: 'pending' },
      { id: 'dns', label: t('configuringDns'), status: 'pending' },
      { id: 'ai', label: t('configuringAi'), status: 'pending' },
      { id: 'sso_control', label: t('configuringSsoControl'), status: 'pending' },
      { id: 'sso_ui', label: t('enablingSsoUi'), status: 'pending' },
      { id: 'finalize', label: t('finalizingSetup'), status: 'pending' },
    ];
    setSetupSteps(steps);
    try {
      const csrfRes = await fetch('/api/auth/csrf');
      const { csrfToken } = await csrfRes.json();
      await followSetupProgress(() => fetch('/api/setup/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          site_name: siteName,
          domain,
          subdomains: { ...subdomains, ui: '' },
          site_name_style: nameStyle,
          branding_revision: brandingRevision,
          icon_config: iconConfig,
          identity_name: identityName || `${siteName} ID`,
          language: selectedLanguage || 'en',
          tls_choice: tlsChoice,
          yen_name: tlsChoice === 'youeye-names' ? yenName : undefined,
          yen_terms_version: tlsChoice === 'youeye-names' ? yenTermsVersion : undefined,
          yen_ct_accepted: tlsChoice === 'youeye-names' ? yenCtAccepted : undefined,
          yen_human_verification_proof: tlsChoice === 'youeye-names' && !yenReusing && !yenVerifiedSetup ? yenClaimProof : undefined,
          yen_verified_setup_session: tlsChoice === 'youeye-names' && !yenReusing && yenVerifiedSetup ? yenSetupSession : undefined,
          byo_dns_provider: tlsChoice === 'byo-provider'
            ? { provider: 'cloudflare', token: byoProviderToken }
            : undefined,
        }),
      }), setupProgressOptions());
      recordSetupCompletion();
    } catch (error) {
      recordSetupFailure(error);
    } finally {
      setupRequestInFlight.current = false;
    }
  }, [siteName, domain, subdomains, nameStyle, brandingRevision, iconConfig, identityName, selectedLanguage, tlsChoice, yenName, yenTermsVersion, yenCtAccepted, yenClaimProof, yenSetupSession, yenVerifiedSetup, yenReusing, byoProviderToken, t, setupProgressOptions, recordSetupCompletion, recordSetupFailure]);

  // Start provisioning when we enter step 4
  const provisioningStarted = useRef(false);
  useEffect(() => {
    if (step === 4 && !provisioningStarted.current) {
      provisioningStarted.current = true;
      handleRunSetup();
    }
  }, [step, handleRunSetup]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (configError) return <div className="mx-auto max-w-lg space-y-4"><h1 className="text-2xl font-semibold">{translateInterface("m522b1511b2bd")}</h1><p role="alert">{translateInterface("mf739af21ccc8")}</p><button type="button" onClick={() => void checkSetupStatus()} className="rounded-md border px-4 py-2">{translateInterface("m942087cc2d41")}</button></div>;

  // Transition wrapper classes
  const getContentClass = () => {
    if (transitioning) {
      return direction === 'forward'
        ? 'opacity-0 -translate-x-4 transition-all duration-200 motion-reduce:transition-none motion-reduce:transform-none'
        : 'opacity-0 translate-x-4 transition-all duration-200 motion-reduce:transition-none motion-reduce:transform-none';
    }
    return 'opacity-100 translate-x-0 transition-all duration-300 motion-reduce:transition-none motion-reduce:transform-none';
  };

  return (
      <div className="onboarding-card my-6 w-full max-w-5xl p-5 sm:p-8">
      {/* Step content */}
      <div ref={contentRef} className={getContentClass()} inert={transitioning}>
        {step === -2 && (
          <SetupLanguage onSelect={handleLanguageSelect} />
        )}

        {step === -3 && (
          <SetupReadiness onReady={handleReady} />
        )}

        {step === -1 && (
          <SetupChoice
            onNewSetup={() => goToStep(1)}
            onRestore={() => goToStep('restore')}
          />
        )}

        {step === 'restore' && (
          <SetupRestore
            onComplete={() => { window.location.assign('/login'); }}
            onBack={() => goToStep(-1, 'back')}
          />
        )}

        {step === 0 && (
          <SetupServerName
            siteName={siteName}
            setSiteName={setSiteName}
            domainSlug={domainSlug}
            setDomainSlug={setDomainSlug}
            tld={tld}
            setTld={(v) => {
              setTld(v);
              if (v !== '__custom__') {
                const isLocal = /^\.(local|test|internal|lan|home|localhost|invalid|example)$/i.test(v);
                if (isLocal && tlsChoice === 'letsencrypt') setTlsChoice('selfsigned');
              }
            }}
            customTld={customTld}
            setCustomTld={setCustomTld}
            subdomains={subdomains}
            setSubdomains={(v) => setSubdomains(prev => ({ ...prev, ...v }))}
            identityName={identityName}
            setIdentityName={setIdentityName}
            tlsChoice={tlsChoice}
            setTlsChoice={setTlsChoice}
            acmeCertIssued={acmeCertIssued}
            setAcmeCertIssued={setAcmeCertIssued}
            yenName={yenName}
            setYenName={(value) => { setYenName(value); setYenClaimProof(''); }}
            yenFqdn={yenFqdn}
            setYenFqdn={setYenFqdn}
            yenTermsVersion={yenTermsVersion}
            setYenTermsVersion={setYenTermsVersion}
            yenCtAccepted={yenCtAccepted}
            setYenCtAccepted={setYenCtAccepted}
            setYenReusing={setYenReusing}
            setYenVerifiedSetup={setYenVerifiedSetup}
            byoDomain={byoDomain}
            setByoDomain={setByoDomain}
            byoProviderToken={byoProviderToken}
            setByoProviderToken={setByoProviderToken}
            onNext={() => goToStep(2)}
            onBack={() => goToStep(1, 'back')}
          />
        )}

        {step === 1 && (
          <TitleStudio
            design={{ ...titleDesign, name: siteName }}
            onChange={(design) => { setTitleDesign(design); setSiteName(design.name); }}
            onContinue={() => goToStep(0)}
            onBack={() => goToStep(-1, 'back')}
          />
        )}

        {step === 2 && (
          <section className="mx-auto max-w-xl space-y-6 text-center">
            <Brand design={nameStyle.mytitle} view="icon" />
            <h1 className="text-2xl font-semibold">{translateInterface("mba865ad5a8d4")}{siteName}?</h1>
            <Brand design={nameStyle.mytitle} />
            <p className="font-mono text-sm break-all">{domain}</p>
            <p className="text-sm text-muted-foreground">{translateInterface("mbbc34c1751ef")}</p>
            <div className="flex flex-wrap justify-between gap-3">
              <button type="button" className="rounded-lg border px-4 py-3" onClick={() => goToStep(0, 'back')}>{translateInterface("m1a38fb5df490")}</button>
              <button type="button" className="rounded-lg bg-primary px-4 py-3 text-primary-foreground" onClick={() => goToStep(tlsChoice === 'youeye-names' && !yenReusing ? 3 : 4)}>{translateInterface("m4da10f1fbb17")}{siteName}</button>
            </div>
          </section>
        )}

        {step === 3 && (
          <SetupNamesVerification
            name={yenName}
            fqdn={yenFqdn}
            useVerifiedSetup={yenVerifiedSetup}
            onVerified={(proof,kind) => { if(kind==='verified_setup')setYenSetupSession(proof);else setYenClaimProof(proof); goToStep(4); }}
            onBack={() => goToStep(2, 'back')}
          />
        )}

        {step === 4 && (
          <SetupProvisioning
            steps={setupSteps}
            isComplete={setupComplete}
            isRestarting={setupRestarting}
            isChecking={setupChecking}
            statusOnlyRetry={setupStatusOnlyRetry}
            error={setupError}
            onRetry={() => {
              if (setupComplete) { handleProvisioningComplete(); return; }
              if (setupStatusOnlyRetry) { void handleCheckSetupStatus(); return; }
              provisioningStarted.current = true;
              setSetupComplete(false);
              setSetupRestarting(false);
              setSetupError('');
              setSetupSteps([]);
              void handleRunSetup();
            }}
            onComplete={handleProvisioningComplete}
          />
        )}

        {step === 5 && (
          <SetupTls
            domain={domain}
            onComplete={() => router.replace(SETUP_COMPLETE_PATH)}
            onBack={() => goToStep(0, 'back')}
          />
        )}

        {step === 6 && (
          <SetupDnsExplainer
            domain={domain}
            siteName={siteName}
            tlsChoice={tlsChoice}
          />
        )}
      </div>
    </div>
  );
}
