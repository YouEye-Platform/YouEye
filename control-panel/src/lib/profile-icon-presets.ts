import presets from "./profile-avatar-presets.json";

export const PROFILE_ICON_CATEGORIES = [
  "Animals",
  "Nature",
  "Space",
  "Hobbies",
  "Objects",
  "Characters",
] as const;

export type ProfileIconCategory = (typeof PROFILE_ICON_CATEGORIES)[number];

export interface ProfileIconPreset {
  id: string;
  label: string;
  emoji: string;
  artwork: string;
  background: readonly [string, string];
  category: ProfileIconCategory;
}

export const PROFILE_ICON_PRESETS: readonly ProfileIconPreset[] = presets.map((preset) => ({
  id: preset.id,
  label: preset.label,
  emoji: preset.emoji,
  artwork: `/api/branding/profile-avatar-art/${preset.id}`,
  category: preset.category as ProfileIconCategory,
  background: [preset.background[0], preset.background[1]],
}));

export function getProfileIconPreset(id: string): ProfileIconPreset | undefined {
  return PROFILE_ICON_PRESETS.find((preset) => preset.id === id);
}
