import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import {
  chromeCandidates,
  chromeLaunchArgs,
  createProfileDir,
  devToolsBrowserId,
  findChrome,
  type LocalBrowserSystem,
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
