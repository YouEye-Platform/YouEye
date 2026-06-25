import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { findUserById } from "@/lib/db/queries/users";
import { describePermission } from "@/lib/permissions/descriptors";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PermissionApprovalForm } from "./permission-approval-form";

interface PermissionApprovalPageProps {
  searchParams: Promise<{
    app_id?: string;
    permission?: string | string[];
    grant_type?: string;
    return_to?: string;
  }>;
}

export default async function PermissionApprovalPage({ searchParams }: PermissionApprovalPageProps) {
  const session = await getSession();
  if (!session) redirect("/login");

  const user = await findUserById(session.userId);
  const displayName = user?.name || session.name || session.username;
  const email = user?.email || session.email;
  const avatarUrl = user?.image ?? null;
  const initials = displayName
    .split(" ")
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "?";

  const params = await searchParams;
  const appId = params.app_id;
  const rawPermissions = Array.isArray(params.permission)
    ? params.permission
    : params.permission
      ? [params.permission]
      : [];
  const permissions = rawPermissions.filter(Boolean);

  if (!appId || permissions.length === 0) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-12">
        <h1 className="text-2xl font-semibold">Permission request unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This request is missing the app or permission details.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6 py-12">
      <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-3">
          <Avatar className="size-12">
            {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
            <AvatarFallback className="text-base">{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-sm text-muted-foreground">{email}</p>
            <p className="truncate font-medium">{displayName}</p>
          </div>
        </div>
        <p className="text-sm font-medium text-muted-foreground">YouEye permission request</p>
        <h1 className="mt-2 text-2xl font-semibold">{appId.replace(/^ye-/, "")} wants access</h1>
        <div className="mt-5 space-y-3">
          {permissions.map((permission) => {
            const descriptor = describePermission(permission);
            return (
              <div key={permission} className="rounded-md border border-border bg-background p-3">
                <p className="font-medium">{descriptor.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{descriptor.description}</p>
                <p className="mt-2 font-mono text-xs text-muted-foreground">{descriptor.permission}</p>
              </div>
            );
          })}
        </div>
        <PermissionApprovalForm
          appId={appId}
          permissions={permissions}
          grantType={params.grant_type ?? "persistent"}
          returnTo={params.return_to}
        />
      </div>
    </main>
  );
}
