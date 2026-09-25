import { purchases } from "./purchases";

const methods = ["getMonthlyCollection", "proposeMonthlyCollection"] as const;
it.each(methods)(
  "binds %s to an authenticated human account",
  async (method) => {
    expect(
      (
        await purchases[method]({
          account_id: "actor",
          args: [{ account_id: "other" }],
        })
      )[0].account_id,
    ).toBe("actor");
    await expect(
      purchases[method]({ project_id: "project", args: [{}] }),
    ).rejects.toThrow("signed in");
    await expect(
      purchases[method]({
        account_id: "actor",
        auth_actor: "agent",
        args: [{}],
      }),
    ).rejects.toThrow("signed in");
  },
);
it("does not expose approval or collection as public account RPCs", () => {
  for (const method of [
    "applyMonthlyCollection",
    "claimMonthlyCollection",
    "maintainMonthlyCollections",
  ])
    expect(purchases).not.toHaveProperty(method);
});
