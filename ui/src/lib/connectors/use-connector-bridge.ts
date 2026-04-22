"use client";

/**
 * React hook for managing a connector UI bridge.
 *
 * Usage:
 *   const { iframeRef, bridge, isReady, error } = useConnectorBridge(
 *     'spotify-music',
 *     'player.html',
 *     'youeye-player-v1',
 *     { token: accessToken }
 *   );
 *
 *   return <iframe ref={iframeRef} src={iframeUrl} />;
 */

import { useRef, useEffect, useState, useCallback } from "react";
import {
  ConnectorBridge,
  connectorUiUrl,
  type ProtocolName,
} from "./postmessage-bridge";

interface UseConnectorBridgeResult {
  /** Attach this to your iframe element */
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  /** The bridge instance (null until iframe loads) */
  bridge: ConnectorBridge | null;
  /** Whether the connector component has sent its ready signal */
  isReady: boolean;
  /** Error message if ready handshake timed out */
  error: string | null;
  /** The iframe src URL */
  iframeUrl: string;
}

export function useConnectorBridge(
  connectorId: string,
  entry: string,
  protocol: ProtocolName,
  initConfig?: Record<string, unknown>,
  connectorsBaseUrl?: string
): UseConnectorBridgeResult {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [bridge, setBridge] = useState<ConnectorBridge | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const iframeUrl = connectorUiUrl(connectorId, entry, connectorsBaseUrl);

  const initBridge = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    // Clean up previous bridge
    bridge?.destroy();

    const b = new ConnectorBridge(iframe, protocol);

    b.on("ready", () => setIsReady(true));
    b.on("error", (data) => {
      setError((data.message as string) || "Connector error");
    });

    setBridge(b);

    // Init after a short delay to let iframe load
    if (initConfig) {
      b.init(initConfig).catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectorId, entry, protocol]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const handleLoad = () => initBridge();
    iframe.addEventListener("load", handleLoad);

    return () => {
      iframe.removeEventListener("load", handleLoad);
      bridge?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initBridge]);

  return { iframeRef, bridge, isReady, error, iframeUrl };
}
