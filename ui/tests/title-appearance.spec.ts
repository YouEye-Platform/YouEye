import test from "node:test";
import assert from "node:assert/strict";
import { resolveTitle } from "@youeye/branding/appearance";
import { defaultDesign } from "@youeye/branding";
import { notifyAppearanceSaved, subscribeAppearanceChanges } from "@youeye/branding/appearance-events";

test("Studio names and legacy styles resolve consistently without changing server identity", () => {
  const shared = { site_name: "Our server", site_name_style: { mytitle: { ...defaultDesign, name: "Our server" }, color: "teal" } };
  const personal = { mytitle: { ...defaultDesign, name: "My corner" }, color: "orange" };
  const legacy = { color: "blue" };
  assert.deepEqual(resolveTitle(shared, null), { name: "Our server", style: shared.site_name_style });
  assert.deepEqual(resolveTitle(shared, personal), { name: "My corner", style: personal });
  assert.deepEqual(resolveTitle(shared, legacy), { name: "Our server", style: legacy });
  const changed = { ...shared, site_name: "New shared title" };
  assert.equal(resolveTitle(changed, personal).name, "My corner");
  assert.equal(resolveTitle(changed, null).name, "New shared title");
  assert.equal(resolveTitle(changed, legacy).name, "New shared title");
  assert.equal(shared.site_name, "Our server");
  assert.equal(resolveTitle(shared, { mytitle: { name: "Unvalidated" } }).name, "Our server");
});

test("appearance invalidation carries no profile data and unsubscribes every listener", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalChannel = globalThis.BroadcastChannel;
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const channels: FakeChannel[] = [];
  class FakeChannel {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    closed = false;
    constructor(public name: string) { channels.push(this); }
    postMessage(data: unknown) {
      assert.equal(data, "youeye:appearance-changed");
      for (const c of channels) if (c !== this && !c.closed) c.onmessage?.({ data });
    }
    close() { this.closed = true; }
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  globalThis.BroadcastChannel = FakeChannel as unknown as typeof BroadcastChannel;
  try {
    let reads = 0;
    const unsubscribe = subscribeAppearanceChanges(() => reads++);
    notifyAppearanceSaved();
    assert.equal(reads, 2); // Same document event plus the simulated second document.
    win.dispatchEvent(new Event("focus"));
    win.dispatchEvent(new Event("pageshow"));
    doc.dispatchEvent(new Event("visibilitychange"));
    assert.equal(reads, 5);
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    channels[0].onmessage?.({ data: { title: "Untrusted title" } });
    assert.equal(reads, 5);
    unsubscribe();
    notifyAppearanceSaved();
    win.dispatchEvent(new Event("focus"));
    assert.equal(reads, 5);
    assert.ok(channels.every(c => c.closed));

    // Browser storage/messaging restrictions do not break a successful save.
    globalThis.BroadcastChannel = class { constructor() { throw new Error("Unavailable"); } } as unknown as typeof BroadcastChannel;
    const fallback = subscribeAppearanceChanges(() => reads++);
    notifyAppearanceSaved();
    assert.equal(reads, 6);
    fallback();
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
    globalThis.BroadcastChannel = originalChannel;
  }
});
