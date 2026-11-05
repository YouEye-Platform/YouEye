import { createTranslator } from "next-intl";
import english from "../../../messages/en.json";

export type PermissionTranslator = (key: string, values?: Record<string, string | number>) => string;
const englishTranslator: PermissionTranslator = createTranslator({ locale: "en", messages: { interface: english.interface as Record<string, string> }, namespace: "interface" });

export interface PermissionDescriptor {
  permission: string;
  title: string;
  description: string;
  category: "identity" | "timeline" | "notifications" | "widgets" | "profile" | "system" | "app" | "connection" | "internet";
  risk: "low" | "medium" | "high";
}

const KNOWN_PERMISSIONS: Record<string, Omit<PermissionDescriptor, "permission" | "title" | "description"> & { titleKey: string; descriptionKey: string }> = {
  "identity:youeye-id:sign-in": {
    titleKey: "ma4879d190e15",
    descriptionKey: "macbfcf2a13fd",
    category: "identity",
    risk: "low",
  },
  "timeline:write": {
    titleKey: "mf0b331de1cbc",
    descriptionKey: "me01e81e2fb96",
    category: "timeline",
    risk: "medium",
  },
  "notifications:send": {
    titleKey: "m883fd0f44fb4",
    descriptionKey: "mb3a67c2868cd",
    category: "notifications",
    risk: "medium",
  },
  "widgets:register": {
    titleKey: "mc1b9e24a7285",
    descriptionKey: "m4393f6db6112",
    category: "widgets",
    risk: "low",
  },
  "profile:read": {
    titleKey: "m0c348b760928",
    descriptionKey: "m844b04beffd0",
    category: "profile",
    risk: "low",
  },
};

function titleFromPermission(permission: string): string {
  return permission
    .split(":")
    .filter(Boolean)
    .map((part) => part.replace(/[-_]/g, " "))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function describePermission(permission: string, t: PermissionTranslator = englishTranslator): PermissionDescriptor {
  const known = KNOWN_PERMISSIONS[permission];
  if (known) return { permission, title: t(known.titleKey), description: t(known.descriptionKey), category: known.category, risk: known.risk };

  if (permission.startsWith("connection:")) {
    const appName = titleFromPermission(permission.replace(/^connection:/, ""));
    return {
      permission,
      title: t("mfd72fe665ce4", { app: appName }),
      description: t("madcc74de8dde", { app: appName }),
      category: "connection",
      risk: "medium",
    };
  }

  if (permission.startsWith("internet:")) {
    const host = permission.replace(/^internet:/, "");
    const title = host.startsWith("*.")
      ? t("m094a871f90b9", { host: titleFromPermission(host.slice(2)) })
      : t("mb9ea77634eb4", { host });
    const description = host.startsWith("*.")
      ? t("m82acc75cde01", { host })
      : t("m9532956379b1", { host });
    return {
      permission,
      title,
      description,
      category: "internet",
      risk: "medium",
    };
  }

  const category = permission.split(":")[0] || "app";
  return {
    permission,
    title: titleFromPermission(permission),
    description: t("mf7ea9482ed9b"),
    category: category === "system" ? "system" : "app",
    risk: "medium",
  };
}
