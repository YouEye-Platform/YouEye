// YE-151: an app's embedded surfaces (widgets, notifications) are built on the address the server gives,
// `https://<the app's subdomain>.<the box's domain>`, never on the page's host minus its first label.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { publicAppOrigin, publicAppUrl, publicBaseDomain } from "../src/lib/surfaces/app-url";
import { surfaceEmbedUrl } from "../src/lib/surfaces/embed-url";

const read = (file: string) => readFileSync(path.join(__dirname, "..", file), "utf8");

test("the box's domain is the host the dashboard was asked on, whole; a service call uses UI_EXTERNAL_URL", () => {
  const env = { UI_EXTERNAL_URL: "https://box.example" };
  // The dashboard on the box's own domain (a YouEye Name, a domain of the owner's, the test template's devvm.test).
  for (const domain of ["azure-delta.ui.bingo", "byka.wtf", "devvm.test", "box.example"]) {
    assert.equal(publicBaseDomain(domain, false, env), domain);
    assert.equal(publicBaseDomain(`${domain}:443`, false, env), domain);
    assert.equal(publicAppOrigin("notes", publicBaseDomain(domain, false, env)), `https://notes.${domain}`);
  }
  // A native app calling the service API arrives on the internal address.
  assert.equal(publicBaseDomain("youeye-ui.youeye:3000", true, env), "box.example");
  assert.equal(publicBaseDomain("box.example", true, {}), "box.example");
  // No domain to build on: an IP address (setup, recovery), a single label, an IPv6 literal.
  for (const host of ["192.168.31.40", "192.168.31.40:3000", "localhost", "[fe80::1]:3000", "", null]) {
    assert.equal(publicBaseDomain(host, false, env), "", String(host));
    assert.equal(publicAppOrigin("notes", publicBaseDomain(host, false, env)), null);
  }
  assert.equal(publicBaseDomain("evil.example/x", false, env), "", "not a host name");
});

test("an app's address uses its own subdomain; one without a subdomain keeps its registered address for widgets", () => {
  assert.equal(publicAppOrigin("my-notes", "box.example"), "https://my-notes.box.example");
  assert.equal(publicAppOrigin(null, "box.example"), null);
  assert.equal(publicAppUrl({ subdomain: "wiki", containerUrl: "http://ye-wiki.youeye:3000" }, "box.example"), "https://wiki.box.example");
  assert.equal(publicAppUrl({ subdomain: null, containerUrl: "http://ye-wiki.youeye:3000" }, "box.example"), "http://ye-wiki.youeye:3000");
});

test("the embed address is the surface's path on the app's address, never another origin", () => {
  assert.equal(
    surfaceEmbedUrl("https://notes.azure-delta.ui.bingo", "/embed/notification?x=1", { notification_id: "n1", surface_id: "s1" }),
    "https://notes.azure-delta.ui.bingo/embed/notification?x=1&notification_id=n1&surface_id=s1",
  );
  assert.equal(surfaceEmbedUrl(null, "/embed"), null);
  assert.equal(surfaceEmbedUrl("https://notes.box.example", ""), null);
  assert.equal(surfaceEmbedUrl("https://notes.box.example", "https://other.example/embed"), null);
  assert.equal(surfaceEmbedUrl("https://notes.box.example", "//other.example/embed"), null);
  assert.equal(surfaceEmbedUrl("http://ye-notes.youeye:3000", "/embed"), null, "an internal address is not embedded");
  assert.equal(surfaceEmbedUrl("not a url", "/embed"), null);
});

test("the notification embed takes app_url from the server and no longer reads the page's host", () => {
  const embed = read("src/components/notifications/notification-surface-embed.tsx");
  assert.match(embed, /surfaceEmbedUrl\(surface\.app_url, surface\.embed_path/);
  assert.doesNotMatch(embed, /window\.location/);
  assert.doesNotMatch(embed, /replace\(\/\^ye-\//);
  const route = read("src/app/api/v1/notifications/route.ts");
  assert.match(route, /publicBaseDomain\(request\.headers\.get\("host"\), false\)/);
  assert.match(route, /app_url: publicAppOrigin\(subdomain, baseDomain\)/);
  const surfaces = read("src/app/api/v1/apps/surfaces/route.ts");
  assert.match(surfaces, /from "@\/lib\/surfaces\/app-url"/);
  assert.doesNotMatch(surfaces, /function publicBaseDomain/);
});
