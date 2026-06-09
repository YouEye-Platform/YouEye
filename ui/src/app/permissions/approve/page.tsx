import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { describePermission } from "@/lib/permissions/descriptors";
import { PermissionApprovalForm } from "./permission-approval-form";

interface PermissionApprovalPageProps {
  searchParams: Promise<{
    app_id?: string;
    permission?: string | string[];
    grant_type?: string;
  }>;
}

export default async function PermissionApprovalPage({ searchParams }: PermissionApprovalPageProps) {
  const session = await getSession();
  if (!session) redirect("/login");

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
        />
      </div>
    </main>
  );
}
