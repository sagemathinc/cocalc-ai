import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  chromeCandidates,
  chromeLaunchArgs,
  createProfileDir,
  devToolsBrowserId,
  findChrome,
  type LocalBrowserSystem,
  startCleanupWatchdog,
  startUrl,
} from "./local-browser";

const TMPFS_MAGIC = 0x01021994;
const EXT4_MAGIC = 0xef53;

function system(patch: Partial<LocalBrowserSystem>): LocalBrowserSystem {
  return {
    platform: "linux",
    env: {},
    home: "/home/u",
    exists: () => false,
    statfsType: () => null,
    run: async () => "",
    ...patch,
  };
}

test("finds the platform's Chrome-family browsers", () => {
  assert.deepEqual(
    chromeCandidates(
      system({ platform: "linux", env: { PATH: "/a:/b" } }),
    ).slice(0, 2),
    ["/a/google-chrome", "/b/google-chrome"],
  );
  assert.equal(
    chromeCandidates(system({ platform: "darwin" }))[0],
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
  assert.equal(
    chromeCandidates(
      system({ platform: "win32", env: { ProgramFiles: "C:\\Program Files" } }),
    )[0],
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  );
  const sys = system({
    env: { PATH: "/usr/bin" },
    exists: (path) => path === "/usr/bin/chromium",
  });
  assert.equal(findChrome(undefined, sys), "/usr/bin/chromium");
  assert.throws(() => findChrome("/nope/chrome", sys), /not found/);
  assert.throws(
    () => findChrome(undefined, system({ env: { PATH: "/x" } })),
    /--chrome/,
  );
  assert.equal(
    findChrome(undefined, {
      ...sys,
      env: { ...sys.env, COCALC_CHROME: "/usr/bin/chromium" },
    }),
    "/usr/bin/chromium",
  );
});

test("launches with a private profile and an OS-chosen DevTools port", () => {
  assert.deepEqual(chromeLaunchArgs({ profileDir: "/p", headless: true }), [
    "--user-data-dir=/p",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disk-cache-size=67108864",
    "--headless=new",
    "--",
    "about:blank",
  ]);
  assert.equal(
    chromeLaunchArgs({ profileDir: "/p", url: "https://cocalc.ai" }).at(-1),
    "https://cocalc.ai",
  );
});

test("memory profiles go on tmpfs, never on a disk filesystem", async () => {
  const shm = system({
    exists: (path) => path === "/dev/shm" || existsSync(path),
    statfsType: (path) => (path === "/dev/shm" ? TMPFS_MAGIC : EXT4_MAGIC),
  });
  if (existsSync("/dev/shm")) {
    const profile = await createProfileDir("memory", shm);
    try {
      assert.match(profile.path, /^\/dev\/shm\/cocalc-browser-/);
      assert.equal(profile.backing, "tmpfs /dev/shm");
    } finally {
      await profile.cleanup();
    }
    assert.equal(existsSync(profile.path), false);
  }
  await assert.rejects(
    createProfileDir(
      "memory",
      system({
        env: { XDG_RUNTIME_DIR: "/run/user/1" },
        exists: () => true,
        statfsType: () => EXT4_MAGIC,
      }),
    ),
    /--profile-storage disk/,
  );
  await assert.rejects(
    createProfileDir("memory", system({ platform: "win32" })),
    /no RAM-backed storage found on win32/,
  );
});

test("macOS memory profiles use a RAM disk that is detached on cleanup", async () => {
  const calls: string[] = [];
  const sys = system({
    platform: "darwin",
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "hdiutil" && args[0] === "attach") return "/dev/disk9\n";
      if (command === "diskutil") throw new Error("erase failed");
      return "";
    },
  });
  await assert.rejects(createProfileDir("memory", sys), /erase failed/);
  assert.deepEqual(calls, [
    "hdiutil attach -nomount ram://1048576",
    calls[1],
    "hdiutil detach /dev/disk9 -force",
  ]);
  assert.match(
    calls[1],
    /^diskutil erasevolume HFS\+ CoCalcBrowser-\w+ \/dev\/disk9$/,
  );
});

test("extracts the per-process DevTools browser id", () => {
  assert.equal(
    devToolsBrowserId(
      JSON.stringify({
        webSocketDebuggerUrl:
          "ws://127.0.0.1:9222/devtools/browser/27eb133c-b57c-4311",
      }),
    ),
    "27eb133c-b57c-4311",
  );
  assert.equal(devToolsBrowserId("not json"), null);
  assert.equal(devToolsBrowserId("{}"), null);
});

test("--url cannot smuggle Chrome switches", () => {
  assert.equal(startUrl(undefined), "about:blank");
  assert.equal(startUrl("https://cocalc.ai/x?y=1"), "https://cocalc.ai/x?y=1");
  for (const bad of [
    "--remote-debugging-address=0.0.0.0",
    "--user-data-dir=/home/u/.config/google-chrome",
    "-incognito",
    "cocalc.ai",
    "javascript:alert(1)",
    "chrome://settings",
    "file:///etc/passwd",
  ]) {
    assert.throws(() => startUrl(bad), /--url must be/, bad);
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const idle = (...extra: string[]) =>
  // "--" so node passes the fake browser switch through instead of parsing it
  spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", "--", ...extra],
    {
      stdio: "ignore",
    },
  );

// The watchdog's lifetime is tied to the process that started it, so start
// it from a separate "CLI" process that the test can SIGKILL.
function ownerWithWatchdog(config: object) {
  const mod = require.resolve("./local-browser");
  return spawn(
    process.execPath,
    [
      "-e",
      `require(${JSON.stringify(mod)}).startCleanupWatchdog(JSON.parse(process.argv[1])); setInterval(() => {}, 1000);`,
      JSON.stringify(config),
    ],
    { stdio: "ignore" },
  );
}

test("watchdog tears everything down when its owner dies", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "browser-watchdog-"));
  const profile = join(tmp, "profile");
  const marker = join(tmp, "forward-removed");
  mkdirSync(profile);
  const browser = idle(`--user-data-dir=${profile}`);
  const owner = ownerWithWatchdog({
    browser: browser.pid,
    browserMarker: `--user-data-dir=${profile}`,
    release: { removeDir: profile },
    forward: {
      command: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync(process.env.MARKER, process.argv[1])",
        "removed",
      ],
      env: { MARKER: marker },
    },
  });
  try {
    await sleep(1500);
    assert.ok(alive(browser.pid!), "browser kept while the owner lives");
    owner.kill("SIGKILL");
    const deadline = Date.now() + 10_000;
    while (
      Date.now() < deadline &&
      (existsSync(profile) || !existsSync(marker) || alive(browser.pid!))
    ) {
      await sleep(100);
    }
    assert.equal(existsSync(profile), false, "profile removed");
    assert.equal(readFileSync(marker, "utf8"), "removed");
    assert.equal(alive(browser.pid!), false, "browser stopped");
  } finally {
    owner.kill("SIGKILL");
    browser.kill("SIGKILL");
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("watchdog never signals a process that is not this session's browser", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "browser-watchdog-"));
  const profile = join(tmp, "profile");
  mkdirSync(profile);
  // e.g. the browser PID was reused by an unrelated process
  const unrelated = idle("--user-data-dir=/somewhere/else");
  const owner = ownerWithWatchdog({
    browser: unrelated.pid,
    browserMarker: `--user-data-dir=${profile}`,
    release: { removeDir: profile },
  });
  try {
    await sleep(1000);
    owner.kill("SIGKILL");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && existsSync(profile)) await sleep(100);
    await sleep(500);
    assert.equal(existsSync(profile), false, "profile still released");
    assert.ok(alive(unrelated.pid!), "unrelated process untouched");
  } finally {
    owner.kill("SIGKILL");
    unrelated.kill("SIGKILL");
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a stopped watchdog leaves everything alone", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "browser-watchdog-"));
  const profile = join(tmp, "profile");
  mkdirSync(profile);
  const browser = idle(`--user-data-dir=${profile}`);
  const watchdog = startCleanupWatchdog({
    browser: browser.pid!,
    browserMarker: `--user-data-dir=${profile}`,
    release: { removeDir: profile },
  });
  try {
    await sleep(500);
    await watchdog.stop();
    await sleep(1500);
    assert.equal(watchdog.pid != null && alive(watchdog.pid), false);
    assert.ok(alive(browser.pid!), "browser left running");
    assert.ok(existsSync(profile), "profile left in place");
  } finally {
    browser.kill("SIGKILL");
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the watchdog stays armed while the owner's own cleanup runs", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "browser-watchdog-"));
  const profile = join(tmp, "profile");
  const entered = join(tmp, "entered-cleanup");
  mkdirSync(profile);
  const browser = idle(`--user-data-dir=${profile}`);
  const mod = require.resolve("./local-browser");
  // The "CLI": start the watchdog, then block forever inside cleanup (e.g. a
  // hung forward removal), which is where it gets SIGKILLed.
  const owner = spawn(
    process.execPath,
    [
      "-e",
      `const m = require(${JSON.stringify(mod)});
       const fs = require("node:fs");
       const w = m.startCleanupWatchdog(JSON.parse(process.argv[1]));
       m.cleanupThenDisarm(
         [() => { fs.writeFileSync(${JSON.stringify(entered)}, ""); return new Promise(() => {}); }],
         w,
         () => {},
       );
       setInterval(() => {}, 1000);`,
      JSON.stringify({
        browser: browser.pid,
        browserMarker: `--user-data-dir=${profile}`,
        release: { removeDir: profile },
      }),
    ],
    { stdio: "ignore" },
  );
  try {
    const t0 = Date.now();
    while (!existsSync(entered) && Date.now() - t0 < 5000) await sleep(50);
    assert.ok(existsSync(entered), "owner entered cleanup");
    owner.kill("SIGKILL");
    const deadline = Date.now() + 10_000;
    while (
      Date.now() < deadline &&
      (existsSync(profile) || alive(browser.pid!))
    ) {
      await sleep(100);
    }
    assert.equal(alive(browser.pid!), false, "browser revoked");
    assert.equal(existsSync(profile), false, "profile released");
  } finally {
    owner.kill("SIGKILL");
    browser.kill("SIGKILL");
    rmSync(tmp, { recursive: true, force: true });
  }
});
