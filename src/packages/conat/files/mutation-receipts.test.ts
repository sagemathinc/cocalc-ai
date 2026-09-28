import { MutationReceipts } from "./mutation-receipts";

const fingerprint = "a".repeat(64);
function fixture() {
  let now = 0;
  const options = {
    maxEntries: 3,
    maxPerScope: 2,
    retentionMs: 100,
    now: () => now,
  };
  return {
    receipts: new MutationReceipts(options),
    options,
    advance: () => {
      now += 101;
    },
  };
}

test("concurrent executions and lost acknowledgment retries run one mutation", async () => {
  const { receipts } = fixture();
  const id = receipts.reserve("project-a");
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const action = jest.fn(() => pending);
  const first = receipts.execute("project-a", id, fingerprint, action);
  const second = receipts.execute("project-a", id, fingerprint, action);
  expect(second).toBe(first);
  await Promise.resolve();
  expect(action).toHaveBeenCalledTimes(1);
  expect(receipts.status("project-a", id)).toBe("running");
  complete();
  await first;
  await receipts.execute("project-a", id, fingerprint, action);
  expect(action).toHaveBeenCalledTimes(1);
  expect(receipts.status("project-a", id)).toBe("succeeded");
});

test("another scope cannot inspect or execute a reservation", async () => {
  const { receipts } = fixture();
  const id = receipts.reserve("project-a");
  const action = jest.fn();
  expect(receipts.status("project-b", id)).toBe("unknown");
  await expect(
    receipts.execute("project-b", id, fingerprint, action),
  ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  expect(action).not.toHaveBeenCalled();
  expect(receipts.status("project-a", id)).toBe("reserved");
});

test("payload substitution is rejected without executing again", async () => {
  const { receipts } = fixture();
  const id = receipts.reserve("project-a");
  const action = jest.fn(async () => {});
  await receipts.execute("project-a", id, fingerprint, action);
  await expect(
    receipts.execute("project-a", id, "b".repeat(64), action),
  ).rejects.toMatchObject({ code: 409 });
  expect(action).toHaveBeenCalledTimes(1);
});

test("a failed mutation is retained and is never repeated", async () => {
  const { receipts } = fixture();
  const id = receipts.reserve("project-a");
  const action = jest.fn(() => {
    throw Object.assign(new Error("failure"), {
      code: "EIO",
      payload: "not retained",
    });
  });
  for (let i = 0; i < 2; i++) {
    await expect(
      receipts.execute("project-a", id, fingerprint, action),
    ).rejects.toMatchObject({ message: "failure", code: "EIO" });
  }
  await receipts
    .execute("project-a", id, fingerprint, action)
    .catch((error) => expect(error.payload).toBeUndefined());
  expect(action).toHaveBeenCalledTimes(1);
  expect(receipts.status("project-a", id)).toBe("failed");
});

test.each([false, true])(
  "expired receipt cannot be recreated (executed=%s)",
  async (executed) => {
    const { receipts, advance } = fixture();
    const id = receipts.reserve("project-a");
    const action = jest.fn(async () => {});
    if (executed) await receipts.execute("project-a", id, fingerprint, action);
    advance();
    await expect(
      receipts.execute("project-a", id, fingerprint, action),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(action).toHaveBeenCalledTimes(executed ? 1 : 0);
  },
);

test("a server restart makes old receipts unknown, not executable", async () => {
  const { receipts, options } = fixture();
  const id = receipts.reserve("project-a");
  const action = jest.fn(async () => {});
  await receipts.execute("project-a", id, fingerprint, action);
  const restarted = new MutationReceipts(options);
  await expect(
    restarted.execute("project-a", id, fingerprint, action),
  ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  expect(action).toHaveBeenCalledTimes(1);
});

test("running work retains budget after caller loss and TTL expiry", async () => {
  const { receipts, advance } = fixture();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const runs = [
    receipts.reserve("project-a"),
    receipts.reserve("project-a"),
  ].map((id) => receipts.execute("project-a", id, fingerprint, () => pending));
  advance();
  expect(() => receipts.reserve("project-a")).toThrow("capacity");
  receipts.reserve("project-b");
  expect(() => receipts.reserve("project-c")).toThrow("capacity");
  finish();
  await Promise.all(runs);
});

test("completed eviction cannot cause a replay or consume another scope's quota", async () => {
  const { receipts } = fixture();
  const id = receipts.reserve("project-a");
  const action = jest.fn(async () => {});
  await receipts.execute("project-a", id, fingerprint, action);
  receipts.reserve("project-a");
  receipts.reserve("project-b");
  receipts.reserve("project-a");
  expect(receipts.status("project-a", id)).toBe("unknown");
  await expect(
    receipts.execute("project-a", id, fingerprint, action),
  ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  expect(action).toHaveBeenCalledTimes(1);
  expect(() => receipts.reserve("project-b")).toThrow("capacity");
});

test("malformed fingerprints cannot consume a reservation", async () => {
  const { receipts } = fixture();
  const id = receipts.reserve("project-a");
  const action = jest.fn(async () => {});
  await expect(
    receipts.execute("project-a", id, "unbounded input", action),
  ).rejects.toMatchObject({ code: 400 });
  expect(receipts.status("project-a", id)).toBe("reserved");
  expect(action).not.toHaveBeenCalled();
});
