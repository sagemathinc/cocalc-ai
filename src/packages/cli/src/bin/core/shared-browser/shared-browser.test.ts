import assert from "node:assert/strict";
import { test } from "node:test";

import { pickSelectExpression, selectScript } from "./page-script";
import { HELD_WHILE_HUMAN_DRIVES, normalizeUrl } from "./server";
import {
  BUNDLED_CHROMIUM,
  findSharedBrowserChrome,
  sharedBrowserChromeArgs,
} from "./service";

test("while the human drives, page actions are held but housekeeping passes", () => {
  for (const method of [
    "Input.dispatchMouseEvent",
    "Input.insertText",
    "Page.navigate",
    "Page.reload",
    "Page.handleJavaScriptDialog",
    "Runtime.evaluate",
    "Runtime.callFunctionOn",
    "Target.createTarget",
    "Target.closeTarget",
    "Target.activateTarget",
    "DOM.setFileInputFiles",
  ])
    assert.ok(HELD_WHILE_HUMAN_DRIVES.test(method), method);
  for (const method of [
    "Runtime.runIfWaitingForDebugger",
    "Runtime.enable",
    "Page.enable",
    "Page.getFrameTree",
    "Page.addScriptToEvaluateOnNewDocument",
    "Target.setAutoAttach",
    "Target.attachToTarget",
    "Network.enable",
    "Page.navigatedWithinDocument",
  ])
    assert.ok(!HELD_WHILE_HUMAN_DRIVES.test(method), method);
});

test("the address bar accepts URLs, hosts and searches but not other schemes", () => {
  assert.equal(normalizeUrl("https://cocalc.ai/x"), "https://cocalc.ai/x");
  assert.equal(normalizeUrl(" cocalc.ai "), "https://cocalc.ai");
  assert.equal(normalizeUrl("localhost:8080/x"), "http://localhost:8080/x");
  assert.equal(normalizeUrl("about:blank"), "about:blank");
  assert.match(
    normalizeUrl("modular forms")!,
    /^https:\/\/duckduckgo\.com\/\?q=modular%20forms$/,
  );
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl("file:///etc/passwd"), null);
  assert.equal(normalizeUrl("  "), null);
});

test("chromium runs headless, unthrottled and container-friendly", () => {
  const args = sharedBrowserChromeArgs("/tmp/p");
  for (const flag of [
    "--user-data-dir=/tmp/p",
    "--headless=new",
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--disable-dev-shm-usage",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-background-timer-throttling",
  ])
    assert.ok(args.includes(flag), flag);
  assert.equal(args.at(-1), "about:blank");
});

test("the bundled chromium is preferred unless a browser is chosen", () => {
  const system = "/usr/bin/chromium";
  const sys = (present: string[], env: Record<string, string> = {}) => ({
    platform: "linux" as NodeJS.Platform,
    env: { PATH: "/usr/bin", ...env },
    home: "/home/user",
    exists: (path: string) => present.includes(path),
  });
  const script = "/opt/cocalc/bin2/cocalc-cli.js";
  assert.equal(
    findSharedBrowserChrome(undefined, sys([BUNDLED_CHROMIUM, system]), script),
    BUNDLED_CHROMIUM,
  );
  // A tools build elsewhere uses its own copy.
  assert.equal(
    findSharedBrowserChrome(
      undefined,
      sys(["/x/bin/chromium/chromium", BUNDLED_CHROMIUM]),
      "/x/bin/cocalc-cli.js",
    ),
    "/x/bin/chromium/chromium",
  );
  assert.equal(
    findSharedBrowserChrome(undefined, sys([system]), script),
    system,
  );
  assert.equal(
    findSharedBrowserChrome(system, sys([BUNDLED_CHROMIUM, system]), script),
    system,
  );
  assert.equal(
    findSharedBrowserChrome(
      undefined,
      sys([BUNDLED_CHROMIUM, system], { COCALC_CHROME: system }),
      script,
    ),
    system,
  );
  assert.throws(
    () => findSharedBrowserChrome(undefined, sys([]), script),
    /No Chromium found/,
  );
});

test("the select hook only acts while the human drives", () => {
  assert.match(selectScript(true), /__cocalcHumanDriving = true/);
  assert.match(selectScript(false), /__cocalcHumanDriving = false/);
  assert.match(pickSelectExpression(2), /selectedIndex = 2/);
});
