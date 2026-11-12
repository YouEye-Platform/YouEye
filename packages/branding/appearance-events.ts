const APPEARANCE_EVENT = "youeye:appearance-changed";
const APPEARANCE_CHANNEL = "youeye-appearance";

/** Publish invalidation only. Each consumer re-reads its own authenticated view. */
export function notifyAppearanceSaved() {
  window.dispatchEvent(new Event(APPEARANCE_EVENT));
  try {
    const channel = new BroadcastChannel(APPEARANCE_CHANNEL);
    channel.postMessage(APPEARANCE_EVENT);
    channel.close();
  } catch { /* Focus/readback also works when browser messaging is unavailable. */ }
}

/** No polling or stored profile data; returning to a tab also refreshes remote edits. */
export function subscribeAppearanceChanges(refresh: () => void): () => void {
  const visible = () => { if (document.visibilityState === "visible") refresh(); };
  window.addEventListener(APPEARANCE_EVENT, refresh);
  window.addEventListener("focus", refresh);
  window.addEventListener("pageshow", refresh);
  document.addEventListener("visibilitychange", visible);
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(APPEARANCE_CHANNEL);
    channel.onmessage = (event) => { if (event.data === APPEARANCE_EVENT) refresh(); };
  } catch { /* The local event and focus listeners remain available. */ }
  return () => {
    window.removeEventListener(APPEARANCE_EVENT, refresh);
    window.removeEventListener("focus", refresh);
    window.removeEventListener("pageshow", refresh);
    document.removeEventListener("visibilitychange", visible);
    channel?.close();
  };
}
