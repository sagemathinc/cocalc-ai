/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { validateHarnessAuthority } from "./harness-authority";
import { validateAnthropicAccountCredentialAuthority } from "./anthropic-credential-relay";

jest.mock("./anthropic-credential-relay", () => ({
  validateAnthropicAccountCredentialAuthority: jest.fn(),
}));

const validate =
  validateAnthropicAccountCredentialAuthority as jest.MockedFunction<
    typeof validateAnthropicAccountCredentialAuthority
  >;

test("revalidates the exact account credential on every request", async () => {
  validate.mockResolvedValue(undefined);
  await validateHarnessAuthority({
    projectId: "1892b11a-6c63-4a92-988d-01dcddc0bc79",
    accountId: "8a52c640-079f-496d-85cb-0147bdf9fd6d",
    profile: {
      version: 2,
      kind: "acp",
      id: "claude-code",
      revision: "0.79.0",
      cwd: "/home/user",
      credentialMode: "project-managed",
      executionPolicy: "full-access",
    },
    credential: {
      version: 1,
      provider: "anthropic",
      mode: "account-api-key",
      credentialId: "13ba1a66-881b-4fe1-b732-15088f82434f",
    },
  });
  expect(validate).toHaveBeenCalledWith({
    projectId: "1892b11a-6c63-4a92-988d-01dcddc0bc79",
    accountId: "8a52c640-079f-496d-85cb-0147bdf9fd6d",
    credentialId: "13ba1a66-881b-4fe1-b732-15088f82434f",
  });
});

test("project-managed credentials require no central authority lookup", async () => {
  validate.mockClear();
  await validateHarnessAuthority({
    projectId: "project",
    accountId: "account",
    profile: {
      version: 1,
      kind: "acp",
      id: "custom",
      revision: "1",
      executable: "/home/user/custom",
      args: [],
      cwd: "/home/user",
      credentialMode: "project-managed",
      executionPolicy: "full-access",
    },
    credential: { version: 1, provider: "project", mode: "project-managed" },
  });
  expect(validate).not.toHaveBeenCalled();
});
