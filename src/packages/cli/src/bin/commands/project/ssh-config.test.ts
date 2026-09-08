import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cloudflaredProxyCommand,
  buildManagedProjectSshConfigLines,
} from "./ssh-config";

test(
  "SSH proxy commands preserve absolute executable paths with spaces and quotes",
  {
    skip: process.platform === "win32",
  },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "cloudflared user's path "));
    try {
      const binary = join(dir, "cloudflared");
      writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
        mode: 0o755,
      });
      const proxyCommand = cloudflaredProxyCommand({
        cloudflared: binary,
        hostname: "%h",
      });
      const lines = buildManagedProjectSshConfigLines({
        alias: "test-project",
        hostName: "ssh.example.test",
        username: "test-project",
        proxyCommand,
      });
      const command = lines
        .find((line) => line.startsWith("  ProxyCommand "))!
        .slice("  ProxyCommand ".length);
      const result = spawnSync(
        "/bin/sh",
        ["-c", command.replace("%h", "ssh.example.test")],
        { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        result.stdout,
        "access\nssh\n--hostname\nssh.example.test\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
