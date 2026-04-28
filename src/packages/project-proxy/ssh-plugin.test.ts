/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { ManagedSshPluginState } from "./ssh-plugin";

describe("managed ssh plugin state", () => {
  const project_id = "11111111-1111-4111-8111-111111111111";

  it("stores the exact account-scoped session after key authorization", async () => {
    const authorizePublicKey = jest.fn().mockResolvedValue({
      project_id,
      account_id: "22222222-2222-4222-8222-222222222222",
      ssh_user: "root",
      port: 2224,
    });
    const state = new ManagedSshPluginState({
      proxy_private_key: "PRIVATE KEY",
      authorizePublicKey,
    });

    await state.noteProjectTarget({
      from_addr: "203.0.113.10:54321",
      user_name: `project-${project_id}`,
    });
    expect(state.getSession("203.0.113.10:54321")).toEqual({
      remote_addr: "203.0.113.10:54321",
      project_id,
    });

    const authorized = await state.authorizePublicKey({
      meta: {
        fromAddr: "203.0.113.10:54321",
        userName: `project-${project_id}`,
      },
      public_key: Buffer.from("abcd"),
    });

    expect(authorizePublicKey).toHaveBeenCalledWith({
      remote_addr: "203.0.113.10:54321",
      target: { type: "project", project_id },
      public_key: Buffer.from("abcd"),
    });
    expect(authorized).toMatchObject({
      project_id,
      account_id: "22222222-2222-4222-8222-222222222222",
      ssh_user: "root",
      port: 2224,
    });
    expect(state.getSession("203.0.113.10:54321")).toEqual({
      remote_addr: "203.0.113.10:54321",
      project_id,
      account_id: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("allows initial next-auth negotiation before sshpiperd knows the username", async () => {
    const authorizePublicKey = jest.fn();
    const state = new ManagedSshPluginState({
      proxy_private_key: "PRIVATE KEY",
      authorizePublicKey,
    });

    await expect(
      state.nextAuthMethods({
        fromAddr: "203.0.113.11:54322",
        userName: "",
      }),
    ).resolves.toEqual(["PUBLICKEY"]);

    expect(state.getSession("203.0.113.11:54322")).toBeUndefined();
    expect(authorizePublicKey).not.toHaveBeenCalled();
  });
});
