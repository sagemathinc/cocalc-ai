/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  lstatSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import {
  BLIT_APPLICATIONS,
  INSTALL_CHROMIUM_APPLICATION_COMMAND,
  INSTALL_IDLE_APPLICATION_COMMAND,
  INSTALL_BLIT_APPLICATION_COMMAND,
  LAUNCH_BLIT_APPLICATION_COMMAND,
  CLEAR_STALE_CHROMIUM_LOCK_COMMAND,
  parseBlitApplicationAvailability,
} from "./blit-applications";

describe("Chromium singleton recovery", () => {
  let home: string;
  let profile: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "chromium profile "));
    profile = join(home, ".config", "chromium");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "Preferences"), "keep me");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  function run(lockHost: string, pid: number, liveSocket = false) {
    symlinkSync(`${lockHost}-${pid}`, join(profile, "SingletonLock"));
    symlinkSync(join(home, "socket"), join(profile, "SingletonSocket"));
    symlinkSync("cookie", join(profile, "SingletonCookie"));
    if (liveSocket) writeFileSync(join(home, "socket"), "socket placeholder");
    const result = spawnSync(
      "bash",
      ["-c", `set -euo pipefail\n${CLEAR_STALE_CHROMIUM_LOCK_COMMAND}`],
      {
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          COCALC_PROJECT_ID: "test-project",
        },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);
    expect(readFileSync(join(profile, "Preferences"), "utf8")).toBe("keep me");
    return lstatSync(join(profile, "SingletonLock"), { throwIfNoEntry: false });
  }
  it("clears a dead local owner's singleton links", () => {
    expect(run(hostname(), 2147483647)).toBeUndefined();
    expect(
      lstatSync(join(profile, "SingletonCookie"), { throwIfNoEntry: false }),
    ).toBeUndefined();
  });
  it("recognizes the previous hostname of this project after restart", () => {
    expect(run("project-test-project", 2147483647)).toBeUndefined();
  });
  it("does not unlock a live process", () => {
    expect(run(hostname(), process.pid)).toBeDefined();
  });
  it("does not unlock a profile from an unrelated host", () => {
    expect(run("another-host", 2147483647)).toBeDefined();
  });
  it("does not unlock when the socket target still exists", () => {
    expect(run(hostname(), 2147483647, true)).toBeDefined();
  });
});

describe("Blit application catalog", () => {
  it("has unique safe application and package identifiers", () => {
    const ids = BLIT_APPLICATIONS.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const app of BLIT_APPLICATIONS) {
      expect(app.id).toMatch(/^[a-z0-9-]+$/);
      expect(app.command.every((argument) => argument.length > 0)).toBe(true);
      if ("install" in app) {
        if (app.install.kind === "apt") {
          expect(app.install.packages.length).toBeGreaterThan(0);
          for (const packageName of app.install.packages) {
            expect(packageName).toMatch(/^[a-z0-9][a-z0-9+.-]*$/);
          }
        } else {
          expect(app.install.command).toContain("set -euo pipefail");
          expect(app.install.summary).not.toHaveLength(0);
        }
      }
    }
  });

  it("launches every graphical app as a native Wayland client", () => {
    // Blit's compositor advertises one hard-coded US-QWERTY keymap and
    // delivers everything else -- umlauts, AltGr characters -- through
    // zwp_text_input_v3, which X11 clients cannot bind. So an app that ends up
    // on Xwayland silently loses non-ASCII input.
    const emacs = BLIT_APPLICATIONS.find(({ id }) => id === "emacs");
    expect(emacs).toMatchObject({
      install: { kind: "apt", packages: ["emacs-pgtk"] },
    });

    for (const id of ["krita", "texstudio"]) {
      const app = BLIT_APPLICATIONS.find((candidate) => candidate.id === id);
      const packages =
        app?.install?.kind === "apt" ? app.install.packages : undefined;
      expect(packages).toContain("qt6-wayland");
      expect(packages).toContain("qtwayland5");
    }
  });

  it("installs Chromium from the pinned XtraDeb Ubuntu repository", () => {
    const chromium = BLIT_APPLICATIONS.find(({ id }) => id === "chromium");
    expect(chromium).toMatchObject({
      command: [
        "chromium",
        "--ozone-platform=wayland",
        "--enable-wayland-ime",
        "--no-sandbox",
        "--disable-gpu",
      ],
      executable: "chromium",
      install: { kind: "script" },
    });
    expect(INSTALL_CHROMIUM_APPLICATION_COMMAND).toContain(
      "5301FA4FD93244FBC6F6149982BB6851C64F6880",
    );
    expect(INSTALL_CHROMIUM_APPLICATION_COMMAND).toContain(
      "https://ppa.launchpadcontent.net/xtradeb/apps/ubuntu/",
    );
    expect(INSTALL_CHROMIUM_APPLICATION_COMMAND).toContain(
      "chromium chromium-driver chromium-sandbox",
    );
    expect(INSTALL_CHROMIUM_APPLICATION_COMMAND).toContain(
      "Suites: $" + "{VERSION_CODENAME:-}",
    );
    const syntax = spawnSync("bash", ["-n"], {
      encoding: "utf8",
      input: INSTALL_CHROMIUM_APPLICATION_COMMAND,
    });
    expect(syntax.stderr).toBe("");
    expect(syntax.status).toBe(0);
  });

  it("installs IDLE for the default Ubuntu Python version", () => {
    const idle = BLIT_APPLICATIONS.find(({ id }) => id === "idle");
    expect(idle).toMatchObject({
      command: ["cocalc-idle"],
      executable: "cocalc-idle",
      install: { kind: "script" },
    });
    expect(INSTALL_IDLE_APPLICATION_COMMAND).toContain(
      'package="idle-python$' + '{python_version}"',
    );
    expect(INSTALL_IDLE_APPLICATION_COMMAND).toContain(
      "exec /usr/bin/python3 -m idlelib",
    );
    const syntax = spawnSync("bash", ["-n"], {
      encoding: "utf8",
      input: INSTALL_IDLE_APPLICATION_COMMAND,
    });
    expect(syntax.stderr).toBe("");
    expect(syntax.status).toBe(0);
  });

  it("passes launch and install values as positional shell arguments", () => {
    const remainingArguments = '"$' + '{@:2}"';
    expect(LAUNCH_BLIT_APPLICATION_COMMAND).toContain(remainingArguments);
    expect(INSTALL_BLIT_APPLICATION_COMMAND).toContain('install -y "$@"');
    expect(LAUNCH_BLIT_APPLICATION_COMMAND).toContain(
      "socket:$HOME/.local/state/cocalc/blit/runtime/server.sock",
    );
    expect(LAUNCH_BLIT_APPLICATION_COMMAND).toContain("exec blit");
    expect(LAUNCH_BLIT_APPLICATION_COMMAND).not.toContain("/opt/cocalc/");
  });

  it("parses explicit installed and missing responses", () => {
    expect(
      parseBlitApplicationAvailability("cocalc-blit-app:installed\n"),
    ).toBe("installed");
    expect(parseBlitApplicationAvailability("cocalc-blit-app:missing\n")).toBe(
      "missing",
    );
    expect(() => parseBlitApplicationAvailability("noise")).toThrow(
      "Unable to determine",
    );
  });
});
