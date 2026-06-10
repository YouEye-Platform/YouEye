export interface PermissionDescriptor {
  permission: string;
  title: string;
  description: string;
  category: "identity" | "timeline" | "notifications" | "widgets" | "profile" | "system" | "app" | "connection" | "internet";
  risk: "low" | "medium" | "high";
}

const KNOWN_PERMISSIONS: Record<string, Omit<PermissionDescriptor, "permission">> = {
  "identity:youeye-id:sign-in": {
    title: "Sign in with YouEye ID",
    description: "Lets this app use your YouEye ID profile to sign you in.",
    category: "identity",
    risk: "low",
  },
  "timeline:write": {
    title: "Write to your timeline",
    description: "Lets this app add activity entries to your YouEye timeline.",
    category: "timeline",
    risk: "medium",
  },
  "notifications:send": {
    title: "Send notifications",
    description: "Lets this app send notifications to your YouEye notification center.",
    category: "notifications",
    risk: "medium",
  },
  "widgets:register": {
    title: "Add homepage widgets",
    description: "Lets this app provide widgets that can appear on your YouEye homepage.",
    category: "widgets",
    risk: "low",
  },
  "profile:read": {
    title: "Read your profile",
    description: "Lets this app read your basic YouEye profile information.",
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

export function describePermission(permission: string): PermissionDescriptor {
  const known = KNOWN_PERMISSIONS[permission];
  if (known) return { permission, ...known };

  if (permission.startsWith("connection:")) {
    const appName = titleFromPermission(permission.replace(/^connection:/, ""));
    return {
      permission,
      title: `Connect to ${appName}`,
      description: `Lets this app use ${appName} through the YouEye proxy for your account.`,
      category: "connection",
      risk: "medium",
    };
  }

  if (permission.startsWith("internet:")) {
    const host = permission.replace(/^internet:/, "");
    const title = host.startsWith("*.")
      ? `Use ${titleFromPermission(host.slice(2))} sites`
      : `Use ${host}`;
    const description = host.startsWith("*.")
      ? `Lets this app connect to matching ${host} sites through the YouEye proxy for your account.`
      : `Lets this app connect to ${host} through the YouEye proxy for your account.`;
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
    description: "This app requested this YouEye permission.",
    category: category === "system" ? "system" : "app",
    risk: "medium",
  };
}
