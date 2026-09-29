/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { initHubApi, transformArgs } from "./index";

test.each([
  ["acquireDemand", { consumer_id: "consumer", scope: { kind: "all" } }],
  ["renewDemand", { consumer_id: "consumer", lease_id: "lease" }],
  ["releaseDemand", { consumer_id: "consumer", lease_id: "lease" }],
  ["inspectDemand", {}],
  ["resolveInvitationRecipient", { query: "Ada" }],
  [
    "listInvitationProjects",
    {
      recipient: { kind: "email", email_address: "ada@example.test" },
      cursor: "page",
    },
  ],
])(
  "%s binds the authenticated human and preserves selection fields",
  async (method, request) => {
    const name = `collaborators.${method}`;
    await expect(
      transformArgs({
        name,
        args: [{ ...request, account_id: "forged" }],
        account_id: "actual",
      }),
    ).resolves.toEqual([{ ...request, account_id: "actual" }]);
    for (const actor of [
      {},
      { host_id: "host" },
      { project_id: "project" },
      { account_id: "agent", auth_actor: "agent" as const },
    ]) {
      await expect(
        transformArgs({ name, args: [request], ...actor }),
      ).rejects.toThrow();
    }
  },
);

test("discovery client preserves bounded results and cursors", async () => {
  const recipients = {
    recipients: [
      { kind: "email", email_address: "ada@example.test", label: "Ada" },
    ],
  };
  const projects = {
    projects: [],
    next_cursor: "next",
    notice: "Refine search",
  };
  const call = jest
    .fn()
    .mockResolvedValueOnce(recipients)
    .mockResolvedValueOnce(projects);
  const api = initHubApi(call);
  await expect(
    api.collaborators.resolveInvitationRecipient({ query: "Ada" }),
  ).resolves.toEqual(recipients);
  await expect(
    api.collaborators.listInvitationProjects({
      recipient: { kind: "email", email_address: "ada@example.test" },
    }),
  ).resolves.toEqual(projects);
});
