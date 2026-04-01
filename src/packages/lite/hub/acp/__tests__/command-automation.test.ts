/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  captureCommandAutomationOutput,
  formatCommandAutomationMarkdown,
  resolveAutomationCommandCwd,
} from "../command-automation";

describe("command automation helpers", () => {
  it("defaults command cwd to the chat directory", () => {
    expect(
      resolveAutomationCommandCwd({
        chatPath: "/root/automations/status.chat",
      }),
    ).toBe("/root/automations");
  });

  it("caps captured output within the configured budget", () => {
    const result = captureCommandAutomationOutput({
      stdout: "a".repeat(400),
      stderr: "b".repeat(400),
      maxOutputBytes: 300,
      preferStderr: true,
    });
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(120);
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(200);
    expect(result.truncated).toBe(true);
  });

  it("formats markdown with command metadata and truncation note", () => {
    const markdown = formatCommandAutomationMarkdown({
      command: "git status --short",
      cwd: "/work/repo",
      timeoutMs: 90_000,
      exitCode: 1,
      stdout: "modified: file.ts\n",
      stderr: "fatal: example\n",
      truncated: true,
      maxOutputBytes: 250_000,
    });
    expect(markdown).toContain("```bash");
    expect(markdown).toContain("**Working directory:** `/work/repo`");
    expect(markdown).toContain("**Exit code:** 1");
    expect(markdown).toContain("**stdout**");
    expect(markdown).toContain("**stderr**");
    expect(markdown).toContain("truncated");
  });
});
