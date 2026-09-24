/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeSubscriptionBundlePaths,
  packClaudeSubscriptionHome,
  restoreClaudeSubscriptionHome,
} from "./claude-subscription-home";

test("opaque Claude auth home round trips without exposing paths outside staging", async () => {
  const source = await mkdtemp(join(tmpdir(), "claude-home-source-"));
  const target = await mkdtemp(join(tmpdir(), "claude-home-target-"));
  try {
    await writeFile(join(source, ".credentials.json"), "opaque-secret", {
      mode: 0o600,
    });
    const payload = await packClaudeSubscriptionHome(source);
    expect(payload).not.toContain("opaque-secret");
    await restoreClaudeSubscriptionHome(target, payload);
    expect(await readFile(join(target, ".credentials.json"), "utf8")).toBe(
      "opaque-secret",
    );
    for (const path of ["../escape", "/escape", "a/../../escape"]) {
      await expect(
        restoreClaudeSubscriptionHome(
          target,
          JSON.stringify({
            version: 1,
            files: [{ path, content: "YQ==" }],
          }),
        ),
      ).rejects.toThrow();
    }
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("refresh preserves only login-time files, never new session data", async () => {
  const home = await mkdtemp(join(tmpdir(), "claude-home-refresh-"));
  try {
    await writeFile(join(home, ".credentials.json"), "old-token");
    const initial = await packClaudeSubscriptionHome(home);
    await writeFile(join(home, ".credentials.json"), "new-token");
    await writeFile(
      join(home, "session-transcript.json"),
      "private conversation",
    );
    const refreshed = await packClaudeSubscriptionHome(
      home,
      claudeSubscriptionBundlePaths(initial),
    );
    expect(refreshed).not.toContain("session-transcript");
    expect(refreshed).not.toContain("private conversation");
    const restored = await mkdtemp(join(tmpdir(), "claude-home-refreshed-"));
    try {
      await restoreClaudeSubscriptionHome(restored, refreshed);
      expect(await readFile(join(restored, ".credentials.json"), "utf8")).toBe(
        "new-token",
      );
    } finally {
      await rm(restored, { recursive: true, force: true });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("auth snapshot refuses symlinks instead of following them", async () => {
  const source = await mkdtemp(join(tmpdir(), "claude-home-symlink-"));
  try {
    await symlink("/etc/passwd", join(source, "linked"));
    await expect(packClaudeSubscriptionHome(source)).rejects.toThrow(
      "unsupported entry",
    );
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});
