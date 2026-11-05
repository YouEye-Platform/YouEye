import test from "node:test";
import assert from "node:assert/strict";
import { timelineSessionRequestCookie, timelineSessionResponseCookies } from "../../shared/timeline-session";

const value = "01234567-89ab-cdef-0123-456789abcdef:YWJjZA==";
const cookie = `ye-pin-session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax`;

test("viewing-session endpoints carry only their exact browser cookie", () => {
  for (const path of ["pin/create", "pin/status", "pin/session"]) {
    assert.equal(timelineSessionRequestCookie(path, value), `ye-pin-session=${value}`);
    assert.deepEqual(timelineSessionResponseCookies(path, [cookie, "cp-session=protected; HttpOnly"]), [cookie]);
    const deletion = "ye-pin-session=; Path=/; Max-Age=0";
    assert.deepEqual(timelineSessionResponseCookies(path, [deletion]), [deletion]);
  }
});

test("other endpoints, forged cookie names and malformed values are excluded", () => {
  for (const path of ["profile", "timeline/collection", "pin/change", "pin/session/extra"]) {
    assert.equal(timelineSessionRequestCookie(path, value), undefined);
    assert.deepEqual(timelineSessionResponseCookies(path, [cookie]), []);
  }
  for (const bad of [undefined, "", value + "; cp-session=other", value + "\r\nInjected: yes", "other:invalid"]) {
    assert.equal(timelineSessionRequestCookie("pin/status", bad), undefined);
  }
  assert.deepEqual(timelineSessionResponseCookies("pin/status", ["ye-pin-session-other=value", "cp-session=protected"]), []);
});
