'use client';

import { useState } from 'react';
import { UserPlus, ArrowRight, ArrowLeft, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useTranslations } from 'next-intl';

interface Props {
  firstName: string;
  setFirstName: (v: string) => void;
  lastName: string;
  setLastName: (v: string) => void;
  username: string;
  setUsername: (v: string) => void;
  email: string;
  setEmail: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  onNext: () => void;
  onBack: () => void;
}

export default function SetupAdminAccount({
  firstName, setFirstName,
  lastName, setLastName,
  username, setUsername,
  email, setEmail,
  password, setPassword,
  onNext, onBack,
}: Props) {
  const t = useTranslations('setup');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');

  const passwordsMatch = password === confirmPassword;
  const passwordLongEnough = password.length >= 8;
  const canProceed = username.trim() && email.trim() && passwordLongEnough && passwordsMatch;

  const handleNext = () => {
    if (!passwordLongEnough) {
      setError(t('passwordMinLength'));
      return;
    }
    if (!passwordsMatch) {
      setError(t('passwordsMustMatch'));
      return;
    }
    setError('');
    onNext();
  };

  return (
    <div className="w-full max-w-md mx-auto space-y-6">
      {/* Header */}
      <div className="text-center animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-5">
          <UserPlus className="h-8 w-8 text-primary" />
        </div>
        <h1 className="text-2xl font-bold mb-2">{t('createAdmin')}</h1>
        <p className="text-muted-foreground text-sm">{t('createAdminDesc')}</p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Name fields */}
      <div className="grid grid-cols-2 gap-3 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-75">
        <div className="space-y-1.5">
          <Label htmlFor="firstName" className="text-sm">{t('firstName')}</Label>
          <Input
            id="firstName"
            value={firstName}
            onChange={e => setFirstName(e.target.value)}
            placeholder="John"
            className="h-11"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lastName" className="text-sm">{t('lastName')}</Label>
          <Input
            id="lastName"
            value={lastName}
            onChange={e => setLastName(e.target.value)}
            placeholder="Doe"
            className="h-11"
          />
        </div>
      </div>

      {/* Username */}
      <div className="space-y-1.5 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-100">
        <Label htmlFor="username" className="text-sm">
          {t('username')} <span className="text-red-500">*</span>
        </Label>
        <Input
          id="username"
          value={username}
          onChange={e => setUsername(e.target.value)}
          placeholder="admin"
          className="h-11"
          autoComplete="username"
        />
      </div>

      {/* Email */}
      <div className="space-y-1.5 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-125">
        <Label htmlFor="email" className="text-sm">
          {t('email')} <span className="text-red-500">*</span>
        </Label>
        <Input
          id="email"
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="admin@example.com"
          className="h-11"
          autoComplete="email"
        />
      </div>

      {/* Password */}
      <div className="space-y-1.5 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-150">
        <Label htmlFor="password" className="text-sm">
          {t('password')} <span className="text-red-500">*</span>
        </Label>
        <div className="relative">
          <Input
            id="password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Min. 8 characters"
            className="h-11 pr-10"
            autoComplete="new-password"
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        {password.length > 0 && !passwordLongEnough && (
          <p className="text-xs text-red-500">{t('passwordMinLength')}</p>
        )}
      </div>

      {/* Confirm Password */}
      <div className="space-y-1.5 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-175">
        <Label htmlFor="confirmPassword" className="text-sm">
          {t('confirmPassword')} <span className="text-red-500">*</span>
        </Label>
        <div className="relative">
          <Input
            id="confirmPassword"
            type={showPassword ? 'text' : 'password'}
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            placeholder={t('confirmPasswordPlaceholder')}
            className={`h-11 pr-10 ${
              confirmPassword.length > 0 && !passwordsMatch
                ? 'border-red-300 focus-visible:ring-red-300'
                : ''
            }`}
            autoComplete="new-password"
          />
        </div>
        {confirmPassword.length > 0 && !passwordsMatch && (
          <p className="text-xs text-red-500">{t('passwordsMustMatch')}</p>
        )}
      </div>

      {/* Navigation */}
      <div className="flex gap-3 pt-2 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200">
        <Button variant="outline" onClick={onBack} className="h-12 px-6">
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t('back')}
        </Button>
        <Button
          onClick={handleNext}
          disabled={!canProceed}
          className="flex-1 h-12 text-base gap-2"
        >
          {t('startSetup')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
