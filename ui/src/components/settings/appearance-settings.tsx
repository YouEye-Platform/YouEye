/**
 * Appearance Settings
 *
 * Combined layout:
 * 1. WordArt section (My WordArt tab + Server Branding tab for admins)
 * 2. Color Theme grid (compact)
 * 3. Dark/Light/System mode toggle
 * 4. Custom theme creation (admin only)
 */

"use client";

import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { useColorTheme } from "@/components/color-theme-provider";
import { useEffect, useState, useCallback } from "react";
import {
  Sun,
  Moon,
  Monitor,
  Check,
  Plus,
  Palette,
  Loader2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ThemeColors } from "@/db/schema";
import type { SiteNameStyle } from "@/lib/db/queries/branding";
import { BrandingTabs } from "@/components/settings/branding-tabs";

interface AppearanceSettingsProps {
  userId: string;
  isAdmin?: boolean;
  siteName: string;
  serverDefault: SiteNameStyle;
  serverBrandingUrl: string | null;
}

interface ThemeListItem {
  id: string;
  name: string;
  colors: ThemeColors;
  isPreset: boolean;
}

const THEME_SWATCH_KEYS = ["primary", "ring", "accent"] as const;
const DARK_SWATCH_KEYS = ["darkPrimary", "darkRing", "darkAccent"] as const;

export function AppearanceSettings({
  userId: _userId,
  isAdmin = false,
  siteName,
  serverDefault,
  serverBrandingUrl,
}: AppearanceSettingsProps) {
  const { theme, setTheme } = useTheme();
  const t = useTranslations("settings.appearance");
  const { activeTheme, setColorTheme, isLoading: themeLoading } = useColorTheme();
  const [allThemes, setAllThemes] = useState<ThemeListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);
  const [showCustomDialog, setShowCustomDialog] = useState(false);

  const modes = [
    { id: "light", label: t("light"), icon: Sun },
    { id: "dark", label: t("dark"), icon: Moon },
    { id: "system", label: t("system"), icon: Monitor },
  ];

  const fetchThemes = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/themes");
      if (res.ok) {
        const data = await res.json();
        setAllThemes(data);
      }
    } catch (err) {
      console.error("Failed to fetch themes:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchThemes();
  }, [fetchThemes]);

  const handleThemeSwitch = async (themeId: string) => {
    if (switching) return;
    setSwitching(themeId);
    try {
      await setColorTheme(themeId);
    } finally {
      setSwitching(null);
    }
  };

  const isDarkMode = theme === "dark";

  return (
    <div className="space-y-10">
      {/* Page header */}
      <div>
        <h2 className="text-xl font-semibold">{t("title")}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Customize the look and feel of your dashboard.
        </p>
      </div>

      {/* ─── WordArt Section ─── */}
      <section className="space-y-4">
        <BrandingTabs
          siteName={siteName}
          serverDefault={serverDefault}
          isAdmin={isAdmin}
          serverBrandingUrl={serverBrandingUrl}
        />
      </section>

      {/* ─── Divider ─── */}
      <div className="border-t" />

      {/* ─── Color Theme Section ─── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">Color Theme</h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              Choose a color palette for the interface.
            </p>
          </div>
          {activeTheme && (
            <Badge variant="secondary" className="gap-1.5">
              <Palette className="w-3 h-3" />
              {activeTheme.name}
            </Badge>
          )}
        </div>

        {loading || themeLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Preset Themes Grid (compact) */}
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
              {allThemes
                .filter((t) => t.isPreset)
                .map((t) => (
                  <ThemeCard
                    key={t.id}
                    theme={t}
                    isActive={activeTheme?.id === t.id}
                    isSwitching={switching === t.id}
                    isDarkMode={isDarkMode}
                    onClick={() => handleThemeSwitch(t.id)}
                  />
                ))}
            </div>

            {/* Custom Themes */}
            {allThemes.some((t) => !t.isPreset) && (
              <div className="space-y-2 pt-1">
                <h4 className="text-sm font-medium text-muted-foreground">
                  Custom Themes
                </h4>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
                  {allThemes
                    .filter((t) => !t.isPreset)
                    .map((t) => (
                      <ThemeCard
                        key={t.id}
                        theme={t}
                        isActive={activeTheme?.id === t.id}
                        isSwitching={switching === t.id}
                        isDarkMode={isDarkMode}
                        onClick={() => handleThemeSwitch(t.id)}
                      />
                    ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Mode Toggle */}
        <div className="pt-2">
          <h4 className="text-sm font-medium mb-2">Mode</h4>
          <div className="flex gap-2">
            {modes.map((m) => {
              const Icon = m.icon;
              const active = theme === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => {
                    setTheme(m.id);
                    fetch("/api/v1/themes/active", {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ mode: m.id }),
                    }).catch(() => {});
                  }}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border-2 transition-colors text-sm ${
                    active
                      ? "border-primary bg-primary/5"
                      : "border-transparent bg-muted hover:bg-accent"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span className="font-medium">{m.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Create Custom Theme (admin only) */}
        {isAdmin && (
          <div className="pt-1">
            <Dialog open={showCustomDialog} onOpenChange={setShowCustomDialog}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2">
                  <Plus className="w-4 h-4" />
                  Create Custom Theme
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Create Custom Theme</DialogTitle>
                </DialogHeader>
                <CustomThemeForm
                  onCreated={() => {
                    setShowCustomDialog(false);
                    fetchThemes();
                  }}
                />
              </DialogContent>
            </Dialog>
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Theme Card (compact) ───────────────────────────────────────────

function ThemeCard({
  theme,
  isActive,
  isSwitching,
  isDarkMode,
  onClick,
}: {
  theme: ThemeListItem;
  isActive: boolean;
  isSwitching: boolean;
  isDarkMode: boolean;
  onClick: () => void;
}) {
  const swatchKeys = isDarkMode ? DARK_SWATCH_KEYS : THEME_SWATCH_KEYS;
  const colors = theme.colors;

  return (
    <Card
      className={`cursor-pointer transition-all hover:scale-[1.02] ${
        isActive
          ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
          : "hover:border-primary/50"
      }`}
      onClick={onClick}
    >
      <CardContent className="p-2.5">
        {/* Color swatches */}
        <div className="flex gap-1 mb-2">
          {swatchKeys.map((key) => (
            <div
              key={key}
              className="w-5 h-5 rounded-full border border-border/50"
              style={{ background: colors[key as keyof ThemeColors] }}
            />
          ))}
        </div>

        {/* Theme name + active indicator */}
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium truncate">{theme.name}</span>
          {isSwitching ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
          ) : isActive ? (
            <Check className="w-3.5 h-3.5 text-primary" />
          ) : null}
        </div>

        {!theme.isPreset && (
          <Badge variant="outline" className="mt-1 text-[9px] px-1 py-0">
            Custom
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Custom Theme Form ──────────────────────────────────────────────

interface ColorField {
  key: keyof ThemeColors;
  label: string;
  section: "light" | "dark";
}

const COLOR_FIELDS: ColorField[] = [
  { key: "background", label: "Background", section: "light" },
  { key: "foreground", label: "Foreground", section: "light" },
  { key: "primary", label: "Primary", section: "light" },
  { key: "primaryForeground", label: "Primary Foreground", section: "light" },
  { key: "secondary", label: "Secondary", section: "light" },
  { key: "secondaryForeground", label: "Secondary Foreground", section: "light" },
  { key: "muted", label: "Muted", section: "light" },
  { key: "mutedForeground", label: "Muted Foreground", section: "light" },
  { key: "accent", label: "Accent", section: "light" },
  { key: "accentForeground", label: "Accent Foreground", section: "light" },
  { key: "card", label: "Card", section: "light" },
  { key: "cardForeground", label: "Card Foreground", section: "light" },
  { key: "popover", label: "Popover", section: "light" },
  { key: "popoverForeground", label: "Popover Foreground", section: "light" },
  { key: "destructive", label: "Destructive", section: "light" },
  { key: "destructiveForeground", label: "Destructive Foreground", section: "light" },
  { key: "border", label: "Border", section: "light" },
  { key: "input", label: "Input", section: "light" },
  { key: "ring", label: "Ring", section: "light" },
  { key: "darkBackground", label: "Background", section: "dark" },
  { key: "darkForeground", label: "Foreground", section: "dark" },
  { key: "darkPrimary", label: "Primary", section: "dark" },
  { key: "darkPrimaryForeground", label: "Primary Foreground", section: "dark" },
  { key: "darkSecondary", label: "Secondary", section: "dark" },
  { key: "darkSecondaryForeground", label: "Secondary Foreground", section: "dark" },
  { key: "darkMuted", label: "Muted", section: "dark" },
  { key: "darkMutedForeground", label: "Muted Foreground", section: "dark" },
  { key: "darkAccent", label: "Accent", section: "dark" },
  { key: "darkAccentForeground", label: "Accent Foreground", section: "dark" },
  { key: "darkCard", label: "Card", section: "dark" },
  { key: "darkCardForeground", label: "Card Foreground", section: "dark" },
  { key: "darkPopover", label: "Popover", section: "dark" },
  { key: "darkPopoverForeground", label: "Popover Foreground", section: "dark" },
  { key: "darkDestructive", label: "Destructive", section: "dark" },
  { key: "darkDestructiveForeground", label: "Destructive Foreground", section: "dark" },
  { key: "darkBorder", label: "Border", section: "dark" },
  { key: "darkInput", label: "Input", section: "dark" },
  { key: "darkRing", label: "Ring", section: "dark" },
];

const DEFAULT_CUSTOM_COLORS: ThemeColors = {
  background: "oklch(1 0 0)",
  foreground: "oklch(0.145 0 0)",
  card: "oklch(1 0 0)",
  cardForeground: "oklch(0.145 0 0)",
  popover: "oklch(1 0 0)",
  popoverForeground: "oklch(0.145 0 0)",
  primary: "oklch(0.205 0 0)",
  primaryForeground: "oklch(0.985 0 0)",
  secondary: "oklch(0.97 0 0)",
  secondaryForeground: "oklch(0.205 0 0)",
  muted: "oklch(0.97 0 0)",
  mutedForeground: "oklch(0.556 0 0)",
  accent: "oklch(0.97 0 0)",
  accentForeground: "oklch(0.205 0 0)",
  destructive: "oklch(0.577 0.245 27.325)",
  destructiveForeground: "oklch(0.985 0 0)",
  border: "oklch(0.922 0 0)",
  input: "oklch(0.922 0 0)",
  ring: "oklch(0.708 0 0)",
  darkBackground: "oklch(0.145 0 0)",
  darkForeground: "oklch(0.985 0 0)",
  darkCard: "oklch(0.205 0 0)",
  darkCardForeground: "oklch(0.985 0 0)",
  darkPopover: "oklch(0.205 0 0)",
  darkPopoverForeground: "oklch(0.985 0 0)",
  darkPrimary: "oklch(0.922 0 0)",
  darkPrimaryForeground: "oklch(0.205 0 0)",
  darkSecondary: "oklch(0.269 0 0)",
  darkSecondaryForeground: "oklch(0.985 0 0)",
  darkMuted: "oklch(0.269 0 0)",
  darkMutedForeground: "oklch(0.708 0 0)",
  darkAccent: "oklch(0.269 0 0)",
  darkAccentForeground: "oklch(0.985 0 0)",
  darkDestructive: "oklch(0.704 0.191 22.216)",
  darkDestructiveForeground: "oklch(0.985 0 0)",
  darkBorder: "oklch(1 0 0 / 10%)",
  darkInput: "oklch(1 0 0 / 15%)",
  darkRing: "oklch(0.556 0 0)",
};

function CustomThemeForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [colors, setColors] = useState<ThemeColors>({ ...DEFAULT_CUSTOM_COLORS });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<"light" | "dark">("light");

  const updateColor = (key: keyof ThemeColors, value: string) => {
    setColors((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError("Theme name is required");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const res = await fetch("/api/v1/themes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), colors }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to create theme");
        return;
      }

      onCreated();
    } catch {
      setError("Failed to create theme");
    } finally {
      setSaving(false);
    }
  };

  const filteredFields = COLOR_FIELDS.filter((f) => f.section === activeSection);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="text-sm font-medium">Theme Name</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Custom Theme"
        />
      </div>

      <div className="flex gap-2">
        <Button
          variant={activeSection === "light" ? "default" : "outline"}
          size="sm"
          onClick={() => setActiveSection("light")}
        >
          <Sun className="w-4 h-4 mr-1" />
          Light Mode
        </Button>
        <Button
          variant={activeSection === "dark" ? "default" : "outline"}
          size="sm"
          onClick={() => setActiveSection("dark")}
        >
          <Moon className="w-4 h-4 mr-1" />
          Dark Mode
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[40vh] overflow-y-auto pr-2">
        {filteredFields.map((field) => (
          <div key={field.key} className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              {field.label}
            </label>
            <div className="flex gap-2 items-center">
              <div
                className="w-8 h-8 rounded-md border border-border shrink-0"
                style={{ background: colors[field.key] }}
              />
              <Input
                value={colors[field.key]}
                onChange={(e) => updateColor(field.key, e.target.value)}
                className="text-xs font-mono h-8"
                placeholder="oklch(0.5 0.1 270)"
              />
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Preview</label>
        <div
          className="rounded-lg border p-4 space-y-2"
          style={{
            background: activeSection === "light" ? colors.background : colors.darkBackground,
            color: activeSection === "light" ? colors.foreground : colors.darkForeground,
            borderColor: activeSection === "light" ? colors.border : colors.darkBorder,
          }}
        >
          <div
            className="rounded-md px-3 py-1.5 text-sm font-medium inline-block"
            style={{
              background: activeSection === "light" ? colors.primary : colors.darkPrimary,
              color: activeSection === "light" ? colors.primaryForeground : colors.darkPrimaryForeground,
            }}
          >
            Primary Button
          </div>
          <div
            className="rounded-md px-3 py-1.5 text-sm inline-block ml-2"
            style={{
              background: activeSection === "light" ? colors.secondary : colors.darkSecondary,
              color: activeSection === "light" ? colors.secondaryForeground : colors.darkSecondaryForeground,
            }}
          >
            Secondary
          </div>
          <p
            className="text-xs mt-2"
            style={{
              color: activeSection === "light" ? colors.mutedForeground : colors.darkMutedForeground,
            }}
          >
            This is muted text showing how content will look.
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button onClick={handleSubmit} disabled={saving} className="w-full">
        {saving ? (
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
        ) : (
          <Plus className="w-4 h-4 mr-2" />
        )}
        Create Theme
      </Button>
    </div>
  );
}
