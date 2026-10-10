import assert from "node:assert/strict";
import { test } from "node:test";

import { networkHint } from "./agent-page";
import { pickSelectExpression, selectScript } from "./page-script";
import {
  clampZoom,
  heldWhileHumanDrives,
  normalizeUrl,
  resolveProjectFile,
} from "./server";
import {
  BUNDLED_CHROMIUM,
  connectCommandFor,
  currentProjectId,
  findSharedBrowserChrome,
  sharedBrowserChromeArgs,
  sharedBrowserProfileDir,
  sharedBrowserTarget,
} from "./service";

test("while the human drives, everything waits but housekeeping that acts on no page (fail closed)", () => {
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
    // Bypasses of the old denylist (#939 review):
    "Target.sendMessageToTarget",
    "Network.setCookie",
    "Network.setCookies",
    "Storage.setCookies",
    "Storage.getCookies",
    "DOM.setAttributeValue",
    "DOM.setOuterHTML",
    "Page.addScriptToEvaluateOnNewDocument",
    "Page.captureScreenshot",
    "Debugger.enable",
    "Fetch.enable",
    "Emulation.setDeviceMetricsOverride",
    "Browser.setDownloadBehavior",
    "Target.exposeDevToolsProtocol",
    // Unknown and malformed methods wait too.
    "Some.futureMethod",
    "",
    undefined,
    42,
  ])
    assert.ok(heldWhileHumanDrives(method), String(method));
  for (const method of [
    "Runtime.runIfWaitingForDebugger",
    "Runtime.enable",
    "Page.enable",
    "Page.getFrameTree",
    "Target.setAutoAttach",
    "Target.attachToTarget",
    "Target.getTargets",
    "Browser.getVersion",
  ])
    assert.ok(!heldWhileHumanDrives(method), method);
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
      sys(["/x/bin/cocalc-chromium/chromium", BUNDLED_CHROMIUM]),
      "/x/bin/cocalc-cli.js",
    ),
    "/x/bin/cocalc-chromium/chromium",
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

test("a .browser file names its own browser; no file means the project's", () => {
  const where = { cwd: "/home/user/work", home: "/home/user" };
  assert.deepEqual(sharedBrowserTarget(undefined, where), {
    appId: "cocalc-browser",
    file: null,
  });
  const a = sharedBrowserTarget("a.browser", where);
  assert.equal(a.file, "/home/user/work/a.browser");
  assert.match(a.appId, /^cocalc-browser-[0-9a-f]{16}$/);
  // The same file, however it is written, is the same browser.
  for (const same of [
    "/home/user/work/a.browser",
    "~/work/a.browser",
    "./x/../a.browser",
  ])
    assert.equal(sharedBrowserTarget(same, where).appId, a.appId);
  assert.notEqual(sharedBrowserTarget("b.browser", where).appId, a.appId);
  // App ids pass through (e.g. from `status`).
  assert.deepEqual(sharedBrowserTarget(a.appId, where), {
    appId: a.appId,
    file: null,
  });
  assert.throws(() => sharedBrowserTarget("a.txt", where), /\.browser file/);
  assert.equal(
    sharedBrowserProfileDir(a.appId, "/home/user"),
    `/home/user/.local/share/cocalc/browser-profiles/${a.appId}`,
  );
});

test("a .browser file's settings, tunnel port and connect command", () => {
  const {
    parseSharedBrowserFile,
    formatSharedBrowserFile,
    sharedBrowserTunnelPort,
  } = require("@cocalc/util/shared-browser");
  assert.deepEqual(parseSharedBrowserFile(""), { runs_on: "project" });
  assert.deepEqual(parseSharedBrowserFile("not json"), { runs_on: "project" });
  const computer = formatSharedBrowserFile({ runs_on: "computer" });
  assert.deepEqual(parseSharedBrowserFile(computer), { runs_on: "computer" });
  const id = "cocalc-browser-464dabaf8307dbcd";
  const port = sharedBrowserTunnelPort(id);
  assert.equal(port, sharedBrowserTunnelPort(id), "stable");
  assert.ok(port >= 20000 && port < 40000);
  assert.notEqual(
    port,
    sharedBrowserTunnelPort("cocalc-browser-0000000000000000"),
  );
  assert.equal(
    connectCommandFor("/home/user/twitter.browser", "p1"),
    "cocalc project browser connect -w p1 --browser /home/user/twitter.browser",
  );
  assert.equal(
    connectCommandFor("/home/user/my x's.browser", "p1"),
    `cocalc project browser connect -w p1 --browser '/home/user/my x'\\''s.browser'`,
  );
});

test("the project id comes from the environment or the project's hostname", () => {
  const id = "9447b19f-aabe-49d8-8aea-f870de179eb0";
  assert.equal(currentProjectId({ COCALC_PROJECT_ID: id }, "x"), id);
  assert.equal(currentProjectId({}, `project-${id}`), id);
  assert.equal(currentProjectId({}, "laptop"), undefined);
});

test("a network failure outside the project explains the free-project limit", () => {
  assert.match(
    networkHint("https://x.com/", "net::ERR_NAME_NOT_RESOLVED"),
    /no internet access.*upgrade their membership/,
  );
  assert.equal(
    networkHint("http://localhost:8000/", "net::ERR_CONNECTION_REFUSED"),
    "",
  );
  assert.equal(networkHint("https://x.com/", "net::ERR_ABORTED"), "");
});

test("page zoom stays between 25% and 500%, in hundredths", () => {
  assert.equal(clampZoom(2), 2);
  assert.equal(clampZoom(1.333333), 1.33);
  assert.equal(clampZoom(0.1), 0.25);
  assert.equal(clampZoom(9), 5);
  assert.equal(clampZoom("x"), 1);
  assert.equal(clampZoom(undefined), 1);
});

test("files offered to a page's file chooser stay inside the home directory", () => {
  const { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } =
    require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const dir = mkdtempSync(join(tmpdir(), "upload-test-"));
  const home = join(dir, "home");
  const outside = join(dir, "secret.txt");
  try {
    mkdirSync(join(home, "docs"), { recursive: true });
    writeFileSync(join(home, "docs", "report.pdf"), "ok");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(home, "link-out"));
    symlinkSync(join(home, "docs", "report.pdf"), join(home, "link-in"));
    const real = require("node:fs").realpathSync(join(home, "docs", "report.pdf"));
    assert.equal(resolveProjectFile("docs/report.pdf", home), real);
    assert.equal(resolveProjectFile(join(home, "docs/report.pdf"), home), real);
    assert.equal(resolveProjectFile("link-in", home), real);
    assert.equal(resolveProjectFile("link-out", home), null);
    assert.equal(resolveProjectFile("../secret.txt", home), null);
    assert.equal(resolveProjectFile(outside, home), null);
    assert.equal(resolveProjectFile("/run/secrets/cocalc/COCALC_BROWSER_KEY", home), null);
    assert.equal(resolveProjectFile("docs", home), null);
    assert.equal(resolveProjectFile("missing.txt", home), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
