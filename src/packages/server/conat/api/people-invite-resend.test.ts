/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import { projects } from "@cocalc/conat/hub/api/projects";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { assertAccountTrustedForProductAccess } from "@cocalc/server/accounts/trusted-product-access";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { resendPeopleInviteLocal } from "@cocalc/server/projects/people-invite-resend";
import { resendCollabInvite } from "./people-invite-resend";

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: jest.fn(),
}));
jest.mock("@cocalc/server/accounts/trusted-product-access", () => ({
  assertAccountTrustedForProductAccess: jest.fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "local",
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: jest.fn(),
}));
jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: jest.fn(),
}));
jest.mock("@cocalc/server/projects/people-invite-resend", () => ({
  resendPeopleInviteLocal: jest.fn(),
}));

const remote = jest.fn();
const projectClient = jest.fn(() => ({ resend: remote }));
beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(getServerSettings)
    .mockResolvedValue({ collaborators_enabled: true } as any);
  jest.mocked(resolveProjectBay).mockResolvedValue({ bay_id: "local" } as any);
  jest
    .mocked(getInterBayBridge)
    .mockReturnValue({ projectCollabInvite: projectClient } as any);
});
function request() {
  return {
    account_id: randomUUID(),
    project_id: randomUUID(),
    invite_id: randomUUID(),
    operation_id: randomUUID(),
    session_hash: "bound-session",
  };
}

it("requires a human session even for receipt inspection", async () => {
  const opts = request();
  await expect(
    resendCollabInvite({ ...opts, session_hash: undefined }),
  ).rejects.toThrow("human session");
  await expect(
    resendCollabInvite({ ...opts, account_id: undefined }),
  ).rejects.toThrow("human session");
  expect(resolveProjectBay).not.toHaveBeenCalled();
  expect(resendPeopleInviteLocal).not.toHaveBeenCalled();
});

it("binds identity/session from authentication and rejects agent principals", async () => {
  const opts = request();
  const [bound] = await projects.resendCollabInvite({
    args: [{ ...opts, account_id: randomUUID(), session_hash: "forged" }],
    account_id: opts.account_id,
    auth_session_hash: "actual-session",
  });
  expect(bound.account_id).toBe(opts.account_id);
  expect(bound.session_hash).toBe("actual-session");
  const [unbound] = await projects.resendCollabInvite({
    args: [{ ...opts }],
    account_id: opts.account_id,
  });
  expect(unbound.session_hash).toBeUndefined();
  await expect(resendCollabInvite(unbound)).rejects.toThrow("human session");
  await expect(
    projects.resendCollabInvite({
      args: [opts],
      account_id: opts.account_id,
      auth_session_hash: "actual-session",
      auth_actor: "agent",
    }),
  ).rejects.toThrow("signed in");
});

it("routes to current project owner and never forwards session or extra client fields", async () => {
  const opts = request();
  jest.mocked(resolveProjectBay).mockResolvedValue({ bay_id: "remote" } as any);
  remote.mockResolvedValue({ status: "unknown", email_sent: null });
  expect(
    await resendCollabInvite({
      ...opts,
      email: "attacker@example.test",
    } as any),
  ).toEqual({ status: "unknown", email_sent: null });
  expect(projectClient).toHaveBeenCalledWith("remote");
  const { session_hash: _, ...expected } = opts;
  expect(remote).toHaveBeenCalledWith(expected);
  expect(resendPeopleInviteLocal).not.toHaveBeenCalled();
  expect(assertAccountTrustedForProductAccess).toHaveBeenCalledWith(
    opts.account_id,
    "resend invitations",
  );
});

it("runs the same owning-bay helper locally", async () => {
  const opts = request();
  await resendCollabInvite(opts);
  const { session_hash: _, ...expected } = opts;
  expect(resendPeopleInviteLocal).toHaveBeenCalledWith(expected);
  expect(remote).not.toHaveBeenCalled();
});

it("rejects disabled service, invalid identity, and unavailable owner before delivery", async () => {
  const opts = request();
  jest
    .mocked(getServerSettings)
    .mockResolvedValue({ collaborators_enabled: false } as any);
  await expect(resendCollabInvite(opts)).rejects.toThrow("unavailable");
  jest
    .mocked(getServerSettings)
    .mockResolvedValue({ collaborators_enabled: true } as any);
  await expect(
    resendCollabInvite({ ...opts, operation_id: "invalid" }),
  ).rejects.toThrow("invalid operation_id");
  jest.mocked(resolveProjectBay).mockResolvedValue(undefined as any);
  await expect(resendCollabInvite(opts)).rejects.toThrow("project not found");
  expect(resendPeopleInviteLocal).not.toHaveBeenCalled();
  expect(remote).not.toHaveBeenCalled();
});
