/**
 * Global App Install Listener
 *
 * Listens for postMessage events from the App Market embed (in CP iframe)
 * and shows toast notifications for app install start/completion.
 *
 * One-way bridge: CP embed handles install tracking internally and
 * communicates results via postMessage. UI never calls CP server-to-server.
 */

"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { Download, CheckCircle2, XCircle } from "lucide-react";

export function AppInstallListener() {
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === "youeye-app-install-started") {
        const { appId, appName } = e.data;
        const toastId = `install-${appId}`;

        toast.loading(`Installing ${appName}...`, {
          id: toastId,
          description: "Installation in progress",
          icon: <Download className="w-4 h-4" />,
          duration: Infinity,
        });
      }

      if (e.data?.type === "youeye-app-install-complete") {
        const { appId, appName, error } = e.data;
        const toastId = `install-${appId}`;

        if (error) {
          toast.error(`${appName} install failed`, {
            id: toastId,
            description: error,
            icon: <XCircle className="w-4 h-4" />,
          });
        } else {
          toast.success(`${appName} installed`, {
            id: toastId,
            icon: <CheckCircle2 className="w-4 h-4" />,
          });
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return null;
}
