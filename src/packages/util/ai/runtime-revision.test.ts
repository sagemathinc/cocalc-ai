/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { CLAUDE_CODE_QUALIFICATION } from "./qualified-harnesses";
import { parseAcpHarnessProfile } from "./runtime";

const profile = {
  version: 2,
  kind: "acp",
  id: "claude-code",
  cwd: "/home/user",
  executionPolicy: "full-access",
  credentialMode: "project-managed",
};

test("profiles saved under a superseded Claude pin run the current one", () => {
  for (const revision of [
    ...(CLAUDE_CODE_QUALIFICATION.package.supersededVersions ?? []),
    CLAUDE_CODE_QUALIFICATION.package.version,
  ])
    expect(parseAcpHarnessProfile({ ...profile, revision }).revision).toBe(
      CLAUDE_CODE_QUALIFICATION.package.version,
    );
  expect(CLAUDE_CODE_QUALIFICATION.package.supersededVersions).toContain(
    "0.81.1",
  );
});

test("unknown Claude revisions still fail closed", () => {
  for (const revision of ["0.81.2", "0.85.0", "latest"])
    expect(() => parseAcpHarnessProfile({ ...profile, revision })).toThrow(
      "Unsupported qualified ACP harness or revision",
    );
});
