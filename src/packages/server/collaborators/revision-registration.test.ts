import { registerProjectionRevisionReceivers } from "./revision-registration";
const job = (project_id: string, account_id = "a") => ({
  project_id,
  account_id,
  generation: null,
  revision: 0,
  after_key: "",
});

test("coalesces projects and skips locally fresh receivers", async () => {
  const due = jest.fn(async (p) => p !== "fresh");
  const register = jest.fn(async () => ({ armed: true }));
  expect(
    await registerProjectionRevisionReceivers(
      [job("p"), job("p", "b"), job("fresh")],
      due,
      register,
    ),
  ).toEqual({ armed: 1, deferred: 0, failed: 0 });
  expect(due.mock.calls).toEqual([["p"], ["fresh"]]);
  expect(register).toHaveBeenCalledTimes(1);
  expect(register).toHaveBeenCalledWith(job("p"));
});

test("unknown registration outcomes do not retry per recipient or stop other projects", async () => {
  const register = jest.fn(async (j) => {
    if (j.project_id === "failed") throw Error("timeout");
    return { armed: j.project_id !== "race" };
  });
  expect(
    await registerProjectionRevisionReceivers(
      [job("failed"), job("failed", "b"), job("race"), job("ok")],
      async () => true,
      register,
    ),
  ).toEqual({ armed: 1, deferred: 1, failed: 1 });
  expect(register).toHaveBeenCalledTimes(3);
});

test("empty and oversized claims cannot trigger unbounded work", async () => {
  const due = jest.fn();
  const register = jest.fn();
  expect(await registerProjectionRevisionReceivers([], due, register)).toEqual({
    armed: 0,
    deferred: 0,
    failed: 0,
  });
  await expect(
    registerProjectionRevisionReceivers(Array(9).fill(job("p")), due, register),
  ).rejects.toThrow("limit");
  expect(due).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
});
