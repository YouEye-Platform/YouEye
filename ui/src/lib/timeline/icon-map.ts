/**
 * Shared Lucide icon map for timeline components.
 *
 * Maps icon name strings (PascalCase from manifests, e.g. "Film")
 * to lucide-react component references. Used by timeline-embed.tsx
 * and timeline-entry-card.tsx to resolve icons dynamically from
 * app manifests instead of hardcoding per-app mappings.
 *
 * Add new icons here as apps declare them — this is the single
 * place to expand, rather than scattering maps across components.
 */

import {
  Film,
  Camera,
  FileText,
  Music,
  Globe,
  Calendar,
  Star,
  Package,
  Search,
  MapPin,
  BookOpen,
  Eye,
  Heart,
  ListPlus,
  Play,
  CloudSun,
  Languages,
  StickyNote,
  MessageCircle,
  Utensils,
  Gamepad2,
  Headphones,
  ShoppingCart,
  Bookmark,
  Clock,
  Download,
  Upload,
  Link,
  Image,
  Video,
  Mic,
  Newspaper,
  Tv,
  Radio,
  Palette,
  Code,
  Terminal,
  Database,
  Mail,
  Bell,
  Settings,
  User,
  Users,
  Folder,
  Archive,
  Trash2,
  type LucideIcon,
} from "lucide-react";

/**
 * Icon name (PascalCase) → Lucide component.
 * Apps declare icon names in their manifest — this map resolves them.
 */
export const LUCIDE_ICON_MAP: Record<string, LucideIcon> = {
  Film,
  Camera,
  FileText,
  Music,
  Globe,
  Calendar,
  Star,
  Package,
  Search,
  MapPin,
  BookOpen,
  Eye,
  Heart,
  ListPlus,
  Play,
  CloudSun,
  Languages,
  StickyNote,
  MessageCircle,
  Utensils,
  Gamepad2,
  Headphones,
  ShoppingCart,
  Bookmark,
  Clock,
  Download,
  Upload,
  Link,
  Image,
  Video,
  Mic,
  Newspaper,
  Tv,
  Radio,
  Palette,
  Code,
  Terminal,
  Database,
  Mail,
  Bell,
  Settings,
  User,
  Users,
  Folder,
  Archive,
  Trash2,
};

/** Resolve a lucide icon by PascalCase name. Returns Package as fallback. */
export function resolveLucideIcon(name: string | null | undefined): LucideIcon {
  if (!name) return Package;
  return LUCIDE_ICON_MAP[name] ?? Package;
}
