'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  type SiteNameStyle,
  DEFAULT_STYLE,
} from '@/lib/wordart-presets';

import SetupLanguage from '@/components/setup/SetupLanguage';
import SetupChoice from '@/components/setup/SetupChoice';
import SetupRestore from '@/components/setup/SetupRestore';
import SetupServerName from '@/components/setup/SetupServerName';
import SetupWordArt from '@/components/setup/SetupWordArt';
import SetupIcon from '@/components/setup/SetupIcon';
import SetupAdminAccount from '@/components/setup/SetupAdminAccount';
import SetupProvisioning from '@/components/setup/SetupProvisioning';
import SetupDnsExplainer from '@/components/setup/SetupDnsExplainer';
import { type IconConfig, DEFAULT_ICON_CONFIG } from '@/lib/icon-config';

// ─── Types ────────────────────────────────────────────────────

interface SetupConfig {
  site_name: string;
  domain: string;
  subdomains: Record<string, string>;
  setup_completed: boolean;
}

type StepStatus = 'pending' | 'running' | 'done' | 'error';

interface SetupStep {
  id: string;
  label: string;
  status: StepStatus;
  message?: string;
}

// Steps: -2=language, -1=choice(new/restore), 0=serverName, 1=wordart, 2=icon, 3=admin, 4=provisioning, 5=dns
// Restore flow: -2=language → -1=choice → 'restore'
type WizardStep = -2 | -1 | 0 | 1 | 2 | 3 | 4 | 5 | 'restore';

// ─── Main Component ──────────────────────────────────────────

export default function SetupPage() {
  const t = useTranslations('setup');
  const router = useRouter();
  const [step, setStep] = useState<WizardStep>(-2);
  const [loading, setLoading] = useState(true);
  const [languageChecked, setLanguageChecked] = useState(false);

  // Step 0: Server name
  const [siteName, setSiteName] = useState('YouEye');
  const [domainSlug, setDomainSlug] = useState('');
  const [tld, setTld] = useState('.local');
  const [subdomains, setSubdomains] = useState({
    control: 'control',
    auth: 'id',
    dns: 'dns',
  });
  const [authentikName, setAuthentikName] = useState('');

  // Step 1: WordArt
  const [nameStyle, setNameStyle] = useState<SiteNameStyle>(DEFAULT_STYLE);

  // Step 2: Icon
  const [iconConfig, setIconConfig] = useState<IconConfig>(DEFAULT_ICON_CONFIG);

  // Step 3: Admin account
  const [adminFirstName, setAdminFirstName] = useState('');
  const [adminLastName, setAdminLastName] = useState('');
  const [adminUsername, setAdminUsername] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');

  // Step 3: Provisioning
  const [setupSteps, setSetupSteps] = useState<SetupStep[]>([]);
  const [setupComplete, setSetupComplete] = useState(false);
  const [setupError, setSetupError] = useState('');

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
      setStep(-1);
    }
    setLanguageChecked(true);
  }, []);

  useEffect(() => {
    if (languageChecked) checkSetupStatus();
  }, [languageChecked]);

  async function checkSetupStatus() {
    try {
      const res = await fetch('/api/setup/config');
      if (res.ok) {
        const config: SetupConfig = await res.json();
        if (config.setup_completed) {
          router.replace('/');
          return;
        }
        if (config.site_name && config.site_name !== 'YouEye') setSiteName(config.site_name);
        if (config.domain) {
          // Parse existing domain into slug + tld
          const lastDot = config.domain.lastIndexOf('.');
          if (lastDot > 0) {
            setDomainSlug(config.domain.slice(0, lastDot));
            setTld('.' + config.domain.slice(lastDot + 1));
          }
        }
        if (config.subdomains) {
          setSubdomains(prev => ({ ...prev, ...config.subdomains }));
        }
      }
    } catch {
      // Config not available yet, use defaults
    }
    setLoading(false);
  }

  // Step navigation with animation
  const goToStep = useCallback((nextStep: WizardStep, dir: 'forward' | 'back' = 'forward') => {
    setDirection(dir);
    setTransitioning(true);
    setTimeout(() => {
      setStep(nextStep);
      setTransitioning(false);
    }, 200);
  }, []);

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
      goToStep(-1);
    }
  }, [goToStep]);

  // Full domain string
  const domain = `${domainSlug}${tld}`;

  // Run setup provisioning
  const handleRunSetup = useCallback(async () => {
    setSetupError('');
    const steps: SetupStep[] = [
      { id: 'config', label: t('savingConfig'), status: 'pending' },
      { id: 'caddy', label: t('settingUpProxy'), status: 'pending' },
      { id: 'dns', label: t('configuringDns'), status: 'pending' },
      { id: 'admin', label: t('creatingAdmin'), status: 'pending' },
      { id: 'sso_control', label: t('configuringSsoControl'), status: 'pending' },
      { id: 'sso_ui', label: t('enablingSsoUi'), status: 'pending' },
      { id: 'finalize', label: t('finalizingSetup'), status: 'pending' },
    ];
    setSetupSteps(steps);

    const csrfRes = await fetch('/api/auth/csrf');
    const { csrfToken } = await csrfRes.json();

    try {
      const res = await fetch('/api/setup/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          site_name: siteName,
          domain,
          subdomains: { ...subdomains, ui: '' },
          admin_first_name: adminFirstName,
          admin_last_name: adminLastName,
          admin_username: adminUsername,
          admin_email: adminEmail,
          admin_password: adminPassword,
          site_name_style: nameStyle,
          icon_config: iconConfig,
          authentik_name: authentikName || `${siteName} ID`,
          language: selectedLanguage || 'en',
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Setup request failed (${res.status}): ${text || 'Unknown error'}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') {
            setSetupComplete(true);
            continue;
          }
          try {
            const event = JSON.parse(data);
            if (event.step && event.status) {
              setSetupSteps(prev =>
                prev.map(s =>
                  s.id === event.step
                    ? { ...s, status: event.status, message: event.message }
                    : s
                )
              );
            }
            if (event.error) {
              setSetupError(event.error);
            }
          } catch {
            // Ignore malformed lines
          }
        }
      }
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : 'Setup failed');
    }
  }, [siteName, domain, subdomains, nameStyle, iconConfig, adminUsername, adminEmail, adminPassword, authentikName, adminFirstName, adminLastName, selectedLanguage, t]);

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

  // Transition wrapper classes
  const getContentClass = () => {
    if (transitioning) {
      return direction === 'forward'
        ? 'opacity-0 -translate-x-4 transition-all duration-200'
        : 'opacity-0 translate-x-4 transition-all duration-200';
    }
    return 'opacity-100 translate-x-0 transition-all duration-300';
  };

  // Step indicator dots (only for steps 0-3, not during restore flow)
  const showDots = typeof step === 'number' && step >= 0 && step <= 3;
  const stepLabels = [t('serverSetup'), t('style'), 'Icon', t('adminAccount')];

  return (
    <div className="w-full max-w-2xl px-4">
      {/* Step dots */}
      {showDots && (
        <div className="flex items-center justify-center gap-2 mb-8 animate-in fade-in duration-300">
          {stepLabels.map((label, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className={`flex items-center gap-1.5 ${i === step ? 'opacity-100' : 'opacity-40'}`}>
                <div className={`w-2.5 h-2.5 rounded-full transition-all duration-300 ${
                  i < step ? 'bg-green-500' : i === step ? 'bg-primary scale-110' : 'bg-muted-foreground/40'
                }`} />
                <span className="text-xs font-medium hidden sm:inline">{label}</span>
              </div>
              {i < stepLabels.length - 1 && (
                <div className={`w-8 h-px ${i < step ? 'bg-green-300' : 'bg-border'}`} />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Step content */}
      <div className={getContentClass()}>
        {step === -2 && (
          <SetupLanguage onSelect={handleLanguageSelect} />
        )}

        {step === -1 && (
          <SetupChoice
            onNewSetup={() => goToStep(0)}
            onRestore={() => goToStep('restore')}
          />
        )}

        {step === 'restore' && (
          <SetupRestore
            onComplete={() => {
              router.replace('/');
            }}
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
            setTld={setTld}
            subdomains={subdomains}
            setSubdomains={(v) => setSubdomains(prev => ({ ...prev, ...v }))}
            authentikName={authentikName}
            setAuthentikName={setAuthentikName}
            onNext={() => goToStep(1)}
          />
        )}

        {step === 1 && (
          <SetupWordArt
            siteName={siteName}
            style={nameStyle}
            setStyle={setNameStyle}
            onNext={() => goToStep(2)}
            onBack={() => goToStep(0, 'back')}
          />
        )}

        {step === 2 && (
          <SetupIcon
            siteName={siteName}
            siteNameStyle={nameStyle}
            iconConfig={iconConfig}
            setIconConfig={setIconConfig}
            onNext={() => goToStep(3)}
            onBack={() => goToStep(1, 'back')}
          />
        )}

        {step === 3 && (
          <SetupAdminAccount
            firstName={adminFirstName}
            setFirstName={setAdminFirstName}
            lastName={adminLastName}
            setLastName={setAdminLastName}
            username={adminUsername}
            setUsername={setAdminUsername}
            email={adminEmail}
            setEmail={setAdminEmail}
            password={adminPassword}
            setPassword={setAdminPassword}
            onNext={() => goToStep(4)}
            onBack={() => goToStep(2, 'back')}
          />
        )}

        {step === 4 && (
          <SetupProvisioning
            steps={setupSteps}
            isComplete={setupComplete}
            error={setupError}
            onRetry={() => {
              provisioningStarted.current = false;
              setSetupComplete(false);
              setSetupError('');
              setSetupSteps([]);
              handleRunSetup();
            }}
            onComplete={() => goToStep(5)}
          />
        )}

        {step === 5 && (
          <SetupDnsExplainer
            domain={domain}
            siteName={siteName}
          />
        )}
      </div>
    </div>
  );
}
