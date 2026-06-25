/**
 * Profile Card — settings page component
 *
 * Lets users edit their name and avatar from the CP dashboard.
 * Mirrors the embed profile client but uses shadcn Card styling
 * and authenticatedFetch() for CSRF-protected requests.
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { User, Upload, Loader2, Check, AlertCircle, X, Smile } from 'lucide-react';
import { authenticatedFetch } from '@/lib/api-client';

// ─── Avatar Presets ──────────────────────────────────────

interface AvatarPreset {
  emoji: string;
  bg: [string, string];
}

const AVATAR_PRESETS: AvatarPreset[] = [
  { emoji: "\u{1F431}", bg: ["#f59e0b", "#d97706"] },
  { emoji: "\u{1F436}", bg: ["#8b5cf6", "#7c3aed"] },
  { emoji: "\u{1F98A}", bg: ["#ef4444", "#dc2626"] },
  { emoji: "\u{1F43C}", bg: ["#6366f1", "#4f46e5"] },
  { emoji: "\u{1F981}", bg: ["#f97316", "#ea580c"] },
  { emoji: "\u{1F438}", bg: ["#22c55e", "#16a34a"] },
  { emoji: "\u{1F427}", bg: ["#06b6d4", "#0891b2"] },
  { emoji: "\u{1F985}", bg: ["#92400e", "#78350f"] },
  { emoji: "\u{1F680}", bg: ["#3b82f6", "#2563eb"] },
  { emoji: "\u2B50", bg: ["#eab308", "#ca8a04"] },
  { emoji: "\u{1F3B5}", bg: ["#ec4899", "#db2777"] },
  { emoji: "\u{1F3AE}", bg: ["#8b5cf6", "#7c3aed"] },
  { emoji: "\u{1F4DA}", bg: ["#14b8a6", "#0d9488"] },
  { emoji: "\u{1F3A8}", bg: ["#f472b6", "#ec4899"] },
  { emoji: "\u{1F4F7}", bg: ["#64748b", "#475569"] },
  { emoji: "\u2615", bg: ["#92400e", "#78350f"] },
  { emoji: "\u{1F30A}", bg: ["#06b6d4", "#0891b2"] },
  { emoji: "\u{1F319}", bg: ["#6366f1", "#4f46e5"] },
  { emoji: "\u2600\uFE0F", bg: ["#f59e0b", "#d97706"] },
  { emoji: "\u{1F33F}", bg: ["#22c55e", "#16a34a"] },
  { emoji: "\u{1F338}", bg: ["#f472b6", "#ec4899"] },
  { emoji: "\u{1F30B}", bg: ["#ef4444", "#b91c1c"] },
  { emoji: "\u{1F48E}", bg: ["#06b6d4", "#0891b2"] },
  { emoji: "\u{1F52E}", bg: ["#a855f7", "#9333ea"] },
  { emoji: "\u26A1", bg: ["#eab308", "#ca8a04"] },
  { emoji: "\u{1F525}", bg: ["#ef4444", "#dc2626"] },
  { emoji: "\u{1F308}", bg: ["#8b5cf6", "#ec4899"] },
  { emoji: "\u{1F3AF}", bg: ["#ef4444", "#dc2626"] },
  { emoji: "\u{1F47E}", bg: ["#22c55e", "#16a34a"] },
  { emoji: "\u{1F916}", bg: ["#64748b", "#475569"] },
  { emoji: "\u{1F984}", bg: ["#d946ef", "#a855f7"] },
  { emoji: "\u{1F47D}", bg: ["#22d3ee", "#06b6d4"] },
];

function renderPresetToBlob(emoji: string, bg: [string, string]): Promise<Blob> {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, bg[0]);
  gradient.addColorStop(1, bg[1]);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.font = `${size * 0.52}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, size / 2, size / 2 + size * 0.03);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob!), 'image/png');
  });
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

// ─── Component ───────────────────────────────────────────

interface ProfileData {
  firstName: string;
  lastName: string;
  email: string;
  username: string;
  isAdmin: boolean;
  avatarUrl?: string;
}

export function ProfileCard() {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');

  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchProfile = useCallback(async () => {
    try {
      const res = await authenticatedFetch('/api/user/profile');
      if (!res.ok) throw new Error('Failed to load profile');
      const data = await res.json();
      setProfile(data);
      setFirstName(data.firstName || '');
      setLastName(data.lastName || '');
      if (data.avatarUrl) setAvatarPreview(data.avatarUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProfile(); }, [fetchProfile]);

  // ─── Name Save ──────────────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);

    try {
      const res = await authenticatedFetch('/api/user/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: firstName.trim(), lastName: lastName.trim() }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save');
      }

      const updated = await res.json();
      setProfile(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // ─── Avatar Upload ──────────────────────────────────

  const uploadAvatar = async (blob: Blob) => {
    setAvatarUploading(true);
    setAvatarError('');

    try {
      const dataUrl = await readAsDataUrl(blob);
      const formData = new FormData();
      formData.append('file', blob, 'avatar.png');
      const res = await fetch('/api/user/avatar', { method: 'POST', body: formData });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Upload failed');
      }

      setAvatarPreview(dataUrl);
      setShowPicker(false);
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setAvatarError('File must be under 5MB');
      return;
    }
    await uploadAvatar(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handlePresetSelect = async (preset: AvatarPreset) => {
    const blob = await renderPresetToBlob(preset.emoji, preset.bg);
    await uploadAvatar(blob);
  };

  const handleAvatarRemove = async () => {
    setAvatarUploading(true);
    setAvatarError('');

    try {
      const res = await fetch('/api/user/avatar', { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Remove failed');
      }
      setAvatarPreview(null);
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Remove failed');
    } finally {
      setAvatarUploading(false);
    }
  };

  const hasChanges = profile && (
    firstName.trim() !== (profile.firstName || '') ||
    lastName.trim() !== (profile.lastName || '')
  );

  const initials = ([firstName, lastName].filter(Boolean).join(' ') || profile?.username || '?')
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Profile
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <div className="w-14 h-14 rounded-full bg-muted animate-pulse" />
            <div className="space-y-2 flex-1">
              <div className="h-4 w-32 bg-muted animate-pulse rounded" />
              <div className="h-3 w-24 bg-muted animate-pulse rounded" />
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <User className="h-5 w-5" />
          Profile
        </CardTitle>
        <CardDescription>Manage your profile picture and account name</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Avatar Section */}
        <div className="space-y-3">
          <Label>Profile Picture</Label>
          <div className="flex items-center gap-4">
            <div className="relative w-14 h-14 flex-shrink-0">
              {avatarPreview ? (
                <img
                  src={avatarPreview}
                  alt="Avatar"
                  className="w-14 h-14 rounded-full object-cover"
                />
              ) : (
                <div className="w-14 h-14 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-semibold text-lg">
                  {initials}
                </div>
              )}
              {avatarUploading && (
                <div className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center">
                  <Loader2 className="h-5 w-5 text-white animate-spin" />
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild disabled={avatarUploading}>
                <label className="cursor-pointer">
                  <Upload className="h-3.5 w-3.5 mr-1.5" />
                  Upload
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleFileUpload}
                    disabled={avatarUploading}
                  />
                </label>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowPicker(!showPicker)}
                disabled={avatarUploading}
              >
                {showPicker ? <X className="h-3.5 w-3.5 mr-1.5" /> : <Smile className="h-3.5 w-3.5 mr-1.5" />}
                {showPicker ? 'Close' : 'Presets'}
              </Button>
              {avatarPreview && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAvatarRemove}
                  disabled={avatarUploading}
                  className="text-red-600 hover:text-red-700"
                >
                  Remove
                </Button>
              )}
            </div>
          </div>

          {avatarError && (
            <p className="text-sm text-red-600 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              {avatarError}
            </p>
          )}

          {showPicker && (
            <div className="p-3 rounded-lg border bg-muted/30">
              <p className="text-xs text-muted-foreground mb-2">Choose an avatar preset:</p>
              <div className="grid grid-cols-8 gap-1.5">
                {AVATAR_PRESETS.map((preset, i) => (
                  <button
                    key={i}
                    onClick={() => handlePresetSelect(preset)}
                    disabled={avatarUploading}
                    className="w-8 h-8 rounded-full flex items-center justify-center text-base cursor-pointer transition-transform hover:scale-110 disabled:opacity-50"
                    style={{
                      background: `linear-gradient(135deg, ${preset.bg[0]}, ${preset.bg[1]})`,
                    }}
                  >
                    {preset.emoji}
                  </button>
                ))}
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Your picture is synced to your account and visible to connected apps.
          </p>
        </div>

        {/* Name Section */}
        <div className="space-y-3">
          <Label>Account Name</Label>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="profile-firstName" className="text-xs text-muted-foreground">First Name</Label>
              <Input
                id="profile-firstName"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="First name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-lastName" className="text-xs text-muted-foreground">Last Name</Label>
              <Input
                id="profile-lastName"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Last name"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Username</Label>
              <div className="px-3 py-2 text-sm border rounded-md bg-muted/50 text-muted-foreground">
                {profile?.username || '\u2014'}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Email</Label>
              <div className="px-3 py-2 text-sm border rounded-md bg-muted/50 text-muted-foreground">
                {profile?.email || '\u2014'}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={saving || !hasChanges} size="sm">
              {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Check className="h-4 w-4 mr-1.5" />}
              Save Name
            </Button>
            {saved && (
              <span className="text-sm text-green-600 flex items-center gap-1">
                <Check className="h-3 w-3" />
                Saved
              </span>
            )}
            {error && (
              <span className="text-sm text-red-600 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {error}
              </span>
            )}
          </div>

          {profile?.isAdmin && (
            <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-primary border border-primary/30 bg-primary/5">
              Administrator
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
