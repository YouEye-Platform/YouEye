import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { spineClient } from "@/lib/spine/client";
import { incusRequest, getServerInfo } from "@/lib/incus/server";

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  try {
    const [metricsResult, serverInfoResult, instancesResult] = await Promise.allSettled([
      spineClient.getMetrics(),
      getServerInfo(),
      incusRequest<string[]>("GET", "/1.0/instances"),
    ]);

    const metrics = metricsResult.status === "fulfilled" ? metricsResult.value : null;
    const serverInfo = serverInfoResult.status === "fulfilled" ? serverInfoResult.value.metadata as Record<string, unknown> : null;
    const instancePaths = instancesResult.status === "fulfilled" ? instancesResult.value.metadata || [] : [];
    const containers = await Promise.all(instancePaths.map(async (path) => {
      const name = path.split("/").pop() || path;
      try {
        const state = await incusRequest<Record<string, unknown>>("GET", `/1.0/instances/${name}/state`);
        const meta = state.metadata || {};
        return { name, status: String(meta.status || "unknown").toLowerCase() };
      } catch {
        return { name, status: "unknown" };
      }
    }));

    return NextResponse.json({
      hostname: metrics?.hostname || "unknown",
      os: metrics?.os || "unknown",
      kernel: metrics?.kernel || "unknown",
      uptime: metrics?.uptime || "unknown",
      load_average: metrics?.load_average || null,
      cpu: metrics?.cpu || null,
      memory: metrics?.memory || null,
      disk: metrics?.disk || null,
      incus: {
        version: (serverInfo?.environment as Record<string, string> | undefined)?.server_version || "unknown",
        storage_pool: (serverInfo?.environment as Record<string, string> | undefined)?.storage || "unknown",
      },
      containers: {
        total: containers.length,
        running: containers.filter((container) => container.status === "running").length,
        stopped: containers.filter((container) => container.status !== "running").length,
        items: containers,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load system info" }, { status: 500 });
  }
}
