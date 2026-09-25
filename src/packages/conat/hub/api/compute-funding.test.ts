import { getHubApiPrincipalPolicies, initHubApi, transformArgs } from "./index";

const methods = [
  "getOwnedPools",
  "audit",
  "getCourseVmRecommendations",
  "setCourseVmRecommendations",
  "previewPoolChange",
  "proposePoolChange",
  "getCourseSummary",
  "listSources",
  "previewAllocation",
  "proposeAllocation",
  "getAllocationStatus",
];

describe("registered computeFunding API", () => {
  it("exposes exactly the account-only funding methods and no approval RPC", () => {
    const policies = getHubApiPrincipalPolicies();
    expect(
      Object.keys(policies)
        .filter((name) => name.startsWith("computeFunding."))
        .sort(),
    ).toEqual(methods.map((method) => `computeFunding.${method}`).sort());
    for (const method of methods) {
      expect(policies[`computeFunding.${method}`]).toBe("account");
    }
    expect(Object.keys(initHubApi(jest.fn()).computeFunding).sort()).toEqual(
      [...methods].sort(),
    );
  });

  it.each(methods)("binds %s to the authenticated account", async (method) => {
    const args = await transformArgs({
      name: `computeFunding.${method}`,
      account_id: "signed-in-account",
      args: [{ account_id: "victim" }],
    });
    expect(args[0].account_id).toBe("signed-in-account");
  });

  it.each(methods)(
    "rejects anonymous, project, host and agent principals for %s",
    async (method) => {
      for (const principal of [
        {},
        { project_id: "project" },
        { host_id: "host" },
        {
          account_id: "agent-owner",
          project_id: "project",
          auth_actor: "agent" as const,
        },
      ]) {
        await expect(
          Promise.resolve().then(() =>
            transformArgs({
              name: `computeFunding.${method}`,
              args: [{ account_id: "victim" }],
              ...principal,
            }),
          ),
        ).rejects.toThrow("signed in");
      }
    },
  );

  it("injects the beneficiary even when listSources has no arguments", async () => {
    expect(
      await transformArgs({
        name: "computeFunding.listSources",
        account_id: "beneficiary",
        args: [],
      }),
    ).toEqual([{ account_id: "beneficiary" }]);
  });
});
