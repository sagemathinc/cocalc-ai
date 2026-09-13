import { purchases } from "./purchases";

const methods = [
  "previewCreditTransfer",
  "proposeCreditTransfer",
  "getCreditTransferStatus",
  "listCreditTransfers",
] as const;
it.each(methods)(
  "binds %s to the authenticated account, not caller JSON",
  async (method) => {
    const result = await purchases[method]({
      account_id: "actor",
      args: [{ account_id: "other", operation_id: "operation" }],
    });
    expect(result[0].account_id).toBe("actor");
  },
);
it.each(methods)(
  "refuses project and agent principals for %s",
  async (method) => {
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
it("does not register internal delivery or apply primitives as public purchases methods", () => {
  expect(purchases).not.toHaveProperty("creditTransferDeliver");
  expect(purchases).not.toHaveProperty("creditTransferVerifyRoot");
  expect(purchases).not.toHaveProperty("applyCreditTransferInTransaction");
});
