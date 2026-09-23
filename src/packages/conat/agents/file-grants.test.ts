/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import {
  agentFileGrantInboxPrefix,
  agentFileGrantSubject,
  normalizeAgentFileGrantRoots,
  normalizeAgentFileGrantMode,
  parseAgentFileGrantSubject,
  validatePreparedAgentFileGrant,
} from "./file-grants";

const binding = {
  account_id: "00000000-0000-4000-8000-000000000001",
  target_project_id: "00000000-0000-4000-8000-000000000002",
  source_project_id: "00000000-0000-4000-8000-000000000003",
  grant_id: "00000000-0000-4000-8000-000000000004",
  agent_id: "00000000-0000-4000-8000-000000000005",
  run_id: "00000000-0000-4000-8000-000000000006",
};

describe("agent file grant protocol", () => {
  it("defaults old grants to read and rejects unknown modes", () => {
    expect(normalizeAgentFileGrantMode(undefined)).toBe("read");
    expect(normalizeAgentFileGrantMode("read")).toBe("read");
    expect(normalizeAgentFileGrantMode("read-write")).toBe("read-write");
    for (const value of ["write", "admin", true, {}, 1])
      expect(() => normalizeAgentFileGrantMode(value)).toThrow();
  });
  it("round trips every authority binding through the subject", () => {
    const subject = agentFileGrantSubject(binding);
    expect(parseAgentFileGrantSubject(subject)).toEqual(binding);
    expect(agentFileGrantInboxPrefix(binding)).toBe(`_INBOX.${subject}`);
    expect(parseAgentFileGrantSubject(`${subject}.extra`)).toBeUndefined();
  });

  it("normalizes roots and removes redundant descendants", () => {
    expect(
      normalizeAgentFileGrantRoots(["docs", "/home/user/docs/api/", "src"]),
    ).toEqual(["docs", "src"]);
    expect(normalizeAgentFileGrantRoots([".", "private"])).toEqual([""]);
    expect(normalizeAgentFileGrantRoots(["data/*/raw"])).toEqual([
      "data/*/raw",
    ]);
  });

  it.each(["../secret", "/tmp/secret", "docs/../../secret"])(
    "rejects escaping root %s",
    (root) => expect(() => normalizeAgentFileGrantRoots([root])).toThrow(),
  );

  it.each([
    ".snapshots",
    ".snapshots/old/secret",
    "/home/user/.ssh/id_ed25519",
    ".local/share/cocalc/runtime/token",
  ])("rejects protected project namespace root %s", (root) =>
    expect(() => normalizeAgentFileGrantRoots([root])).toThrow(
      "protected project namespace",
    ),
  );

  it("requires prepared grant metadata to match every subject binding", () => {
    const prepared: any = {
      version: 1,
      grant: {
        grant_id: binding.grant_id,
        account_id: binding.account_id,
        agent_id: binding.agent_id,
        source_project_id: binding.source_project_id,
        target_project_id: binding.target_project_id,
        roots: ["docs"],
        mode: "read",
      },
      subject: agentFileGrantSubject(binding),
      connection: {},
      token: "token",
      expires_at: Date.now() + 60_000,
    };
    expect(() => validatePreparedAgentFileGrant(prepared)).not.toThrow();

    for (const field of ["account_id", "agent_id", "source_project_id"]) {
      expect(() =>
        validatePreparedAgentFileGrant({
          ...prepared,
          grant: { ...prepared.grant, [field]: randomUUID() },
        }),
      ).toThrow("mismatched or expired");
    }
  });
});
