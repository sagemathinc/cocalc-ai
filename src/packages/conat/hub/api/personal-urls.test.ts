import { getHubApiPrincipalPolicy, initHubApi, transformArgs } from "./index";

test.each([
  "getUsername",
  "setUsername",
  "releaseRedirect",
  "resolveOwner",
  "resolveUrl",
])(
  "personalUrls.%s requires a human account and binds its actor",
  async (method) => {
    const name = `personalUrls.${method}`;
    expect(getHubApiPrincipalPolicy(name)).toBe("account");
    await expect(
      transformArgs({
        name,
        args: [{ account_id: "forged", owner_account_id: "target" }],
        account_id: "actual",
      }),
    ).resolves.toEqual([{ account_id: "actual", owner_account_id: "target" }]);
    for (const principal of [
      {},
      { project_id: "project" },
      { host_id: "host" },
      { account_id: "agent", auth_actor: "agent" as const },
    ])
      await expect(
        transformArgs({ name, args: [{}], ...principal }),
      ).rejects.toThrow();
  },
);

test("release binds only the authenticated session, discarding forged session hashes", async () => {
  const name = "personalUrls.releaseRedirect";
  for (const auth_session_hash of ["bound", undefined]) {
    const [opts] = await transformArgs({
      name,
      account_id: "actual",
      auth_session_hash,
      args: [
        {
          session_hash: "forged",
          owner_account_id: "target",
          username: "zephyr",
          reason: "cleanup",
        },
      ],
    });
    expect(opts.session_hash).toBe(auth_session_hash);
    expect(opts.owner_account_id).toBe("target");
  }
});

test("namespace dispatch preserves optional get and URL inspection arguments", async () => {
  const call = jest.fn().mockResolvedValue({});
  const api = initHubApi(call);
  await api.personalUrls.getUsername();
  expect(call).toHaveBeenLastCalledWith(
    expect.objectContaining({ name: "personalUrls.getUsername", args: [] }),
  );
  await api.personalUrls.resolveUrl({
    url: "/u/zephyr/agents/helper",
    inspect: true,
  });
  expect(call).toHaveBeenLastCalledWith(
    expect.objectContaining({
      name: "personalUrls.resolveUrl",
      args: [{ url: "/u/zephyr/agents/helper", inspect: true }],
    }),
  );
});
