import { isResetBusy, retryWhileResetBusy } from "./reset-busy";

const busy = { reset: false, refused: "busy", history_epoch: 1, count: 0 };
const busyError = Object.assign(
  new Error(
    "resetHistory: another reset of this history is in progress; try again later",
  ),
  { code: 409 },
);

describe("isResetBusy", () => {
  it("the refusal and the 409 error, nothing else", () => {
    expect(isResetBusy(busy)).toBe(true);
    expect(isResetBusy(busyError)).toBe(true);
    expect(isResetBusy({ ...busy, refused: "moved" })).toBe(false);
    expect(isResetBusy({ reset: true })).toBe(false);
    expect(
      isResetBusy(Object.assign(new Error("conflict"), { code: 409 })),
    ).toBe(false);
    expect(isResetBusy(undefined)).toBe(false);
  });
});

describe("retryWhileResetBusy: callers see the other reset's outcome, as when they waited", () => {
  const opts = { delayMs: 1 };

  it("retries a busy refusal, then returns the real answer", async () => {
    const answers = [busy, busy, { reset: false, refused: "epoch" }];
    const reset = jest.fn(async () => answers.shift());
    expect(await retryWhileResetBusy(reset, opts)).toEqual({
      reset: false,
      refused: "epoch",
    });
    expect(reset).toHaveBeenCalledTimes(3);
  });

  it("retries the 409 error the same way", async () => {
    let n = 0;
    const reset = jest.fn(async () => {
      if (n++ == 0) throw busyError;
      return { reset: true };
    });
    expect(await retryWhileResetBusy(reset, opts)).toEqual({ reset: true });
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it("other errors are thrown at once", async () => {
    const reset = jest.fn(async () => {
      throw Object.assign(new Error("disk full"), { code: 507 });
    });
    await expect(retryWhileResetBusy(reset, opts)).rejects.toThrow("disk full");
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("gives up after the attempts, with the last answer", async () => {
    const reset = jest.fn(async () => busy);
    expect(await retryWhileResetBusy(reset, { ...opts, attempts: 4 })).toEqual(
      busy,
    );
    expect(reset).toHaveBeenCalledTimes(4);
    const failing = jest.fn(async () => {
      throw busyError;
    });
    await expect(
      retryWhileResetBusy(failing, { ...opts, attempts: 3 }),
    ).rejects.toThrow("another reset");
    expect(failing).toHaveBeenCalledTimes(3);
  });
});
