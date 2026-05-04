/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  maybeActivateRuntimeUser,
  rewriteGroup,
  rewritePasswd,
  rewriteShadow,
  rewriteUbuntuAptSources,
} from "./runtime-bootstrap";

const runtime = {
  user: "user",
  uid: 2001,
  gid: 2001,
  home: "/home/user",
  shell: "/bin/bash",
};

describe("runtime bootstrap rewrite helpers", () => {
  it("appends a canonical runtime user without disturbing unrelated uid 1000 users", () => {
    const current = [
      "root:x:0:0:root:/root:/bin/bash",
      "ubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash",
      "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
      "",
    ].join("\n");
    expect(rewritePasswd(current, runtime)).toBe(
      [
        "root:x:0:0:root:/root:/bin/bash",
        "ubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash",
        "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
        "user:x:2001:2001:CoCalc User:/home/user:/bin/bash",
        "",
      ].join("\n"),
    );
  });

  it("appends a canonical runtime group without disturbing unrelated gid 1000 groups", () => {
    const current = ["root:x:0:", "ubuntu:x:1000:", "daemon:x:1:", ""].join(
      "\n",
    );
    expect(rewriteGroup(current, runtime)).toBe(
      ["root:x:0:", "ubuntu:x:1000:", "daemon:x:1:", "user:x:2001:", ""].join(
        "\n",
      ),
    );
  });

  it("ensures the runtime user has a valid shadow entry", () => {
    const current = [
      "root:*:19993:0:99999:7:::",
      "ubuntu:!:19993:0:99999:7:::",
      "",
    ].join("\n");
    expect(rewriteShadow(current, runtime)).toContain("user:$6$cocalcruntime$");
  });

  it("rewrites ubuntu apt sources to the configured mirror", () => {
    const current = [
      "Types: deb",
      "URIs: http://archive.ubuntu.com/ubuntu/",
      "Suites: resolute resolute-updates resolute-backports",
      "",
      "Types: deb",
      "URIs: http://security.ubuntu.com/ubuntu/",
      "Suites: resolute-security",
      "",
    ].join("\n");
    expect(
      rewriteUbuntuAptSources(
        current,
        "http://us-west3.gce.archive.ubuntu.com/ubuntu/",
      ),
    ).toContain("URIs: http://us-west3.gce.archive.ubuntu.com/ubuntu/");
  });
});

describe("runtime bootstrap writable state repair", () => {
  const originalEnv = process.env;
  const originalGetuid = process.getuid;
  const originalSetuid = process.setuid;
  const originalSetgid = process.setgid;
  const originalSetgroups = process.setgroups;
  const originalChdir = process.chdir;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      COCALC_RUNTIME_BOOTSTRAP: "1",
      COCALC_RUNTIME_USER: "user",
      COCALC_RUNTIME_UID: "2001",
      COCALC_RUNTIME_GID: "2001",
      COCALC_RUNTIME_HOME: "/home/user",
      SHELL: "/bin/bash",
    };
    process.getuid = jest.fn(() => 0);
    process.setuid = jest.fn();
    process.setgid = jest.fn();
    process.setgroups = jest.fn();
    process.chdir = jest.fn();
  });

  afterEach(() => {
    process.env = originalEnv;
    process.getuid = originalGetuid;
    process.setuid = originalSetuid;
    process.setgid = originalSetgid;
    process.setgroups = originalSetgroups;
    process.chdir = originalChdir;
    jest.restoreAllMocks();
  });

  it("repairs tmp and apt state even when required packages are already present", async () => {
    const mkdir = jest.spyOn(require("node:fs/promises"), "mkdir");
    const chmod = jest.spyOn(require("node:fs/promises"), "chmod");
    const chown = jest.spyOn(require("node:fs/promises"), "chown");
    const rm = jest.spyOn(require("node:fs/promises"), "rm");
    const access = jest.spyOn(require("node:fs/promises"), "access");
    const readFile = jest.spyOn(require("node:fs/promises"), "readFile");
    const writeFile = jest.spyOn(require("node:fs/promises"), "writeFile");

    access.mockResolvedValue(undefined as never);
    readFile.mockImplementation(async (path: string) => {
      if (path === "/etc/passwd") {
        return "root:x:0:0:root:/root:/bin/bash\n";
      }
      if (path === "/etc/group") {
        return "root:x:0:\n";
      }
      if (path === "/etc/shadow") {
        return "root:*:19993:0:99999:7:::\n";
      }
      if (path === "/etc/apt/sources.list.d/ubuntu.sources") {
        return [
          "Types: deb",
          "URIs: http://archive.ubuntu.com/ubuntu/",
          "Suites: resolute resolute-updates resolute-backports",
          "",
          "Types: deb",
          "URIs: http://security.ubuntu.com/ubuntu/",
          "Suites: resolute-security",
          "",
        ].join("\n");
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mkdir.mockResolvedValue(undefined as never);
    chmod.mockResolvedValue(undefined as never);
    chown.mockResolvedValue(undefined as never);
    rm.mockResolvedValue(undefined as never);
    writeFile.mockResolvedValue(undefined as never);

    await maybeActivateRuntimeUser();

    expect(mkdir).toHaveBeenCalledWith("/tmp", {
      recursive: true,
      mode: 0o1777,
    });
    expect(chmod).toHaveBeenCalledWith("/tmp", 0o1777);
    expect(chown).toHaveBeenCalledWith("/tmp", 0, 0);
    expect(rm).toHaveBeenCalledWith("/var/lib/apt/lists", {
      recursive: true,
      force: true,
    });
  });

  it("rewrites ubuntu apt sources when a mirror policy is configured", async () => {
    process.env.COCALC_APT_UBUNTU_MIRROR =
      "http://us-west3.gce.archive.ubuntu.com/ubuntu/";
    const mkdir = jest.spyOn(require("node:fs/promises"), "mkdir");
    const chmod = jest.spyOn(require("node:fs/promises"), "chmod");
    const chown = jest.spyOn(require("node:fs/promises"), "chown");
    const rm = jest.spyOn(require("node:fs/promises"), "rm");
    const access = jest.spyOn(require("node:fs/promises"), "access");
    const readFile = jest.spyOn(require("node:fs/promises"), "readFile");
    const writeFile = jest.spyOn(require("node:fs/promises"), "writeFile");

    access.mockResolvedValue(undefined as never);
    readFile.mockImplementation(async (path: string) => {
      if (path === "/etc/passwd") {
        return "root:x:0:0:root:/root:/bin/bash\n";
      }
      if (path === "/etc/group") {
        return "root:x:0:\n";
      }
      if (path === "/etc/shadow") {
        return "root:*:19993:0:99999:7:::\n";
      }
      if (path === "/etc/apt/sources.list.d/ubuntu.sources") {
        return [
          "Types: deb",
          "URIs: http://archive.ubuntu.com/ubuntu/",
          "Suites: resolute resolute-updates resolute-backports",
          "",
          "Types: deb",
          "URIs: http://security.ubuntu.com/ubuntu/",
          "Suites: resolute-security",
          "",
        ].join("\n");
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mkdir.mockResolvedValue(undefined as never);
    chmod.mockResolvedValue(undefined as never);
    chown.mockResolvedValue(undefined as never);
    rm.mockResolvedValue(undefined as never);
    writeFile.mockResolvedValue(undefined as never);

    await maybeActivateRuntimeUser();

    expect(writeFile).toHaveBeenCalledWith(
      "/etc/apt/sources.list.d/ubuntu.sources",
      expect.stringContaining("http://us-west3.gce.archive.ubuntu.com/ubuntu/"),
      { mode: 0o644 },
    );
  });
});
