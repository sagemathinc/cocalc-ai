import { createApiRelayMeter, meteredStream } from "./api-relay-meter";
import { once } from "node:events";

const request = {
  project_id: "p",
  session_id: "s",
  transport: "http" as const,
  target: "hub",
};
function updater(limit = 1024) {
  return jest.fn(async (req) => ({
    account_id: "a",
    allowance: req.close ? req.sent + req.received : limit,
    expires_at: Date.now() + 60_000,
  }));
}

it("shares an allowance across both directions and settles exact usage once", async () => {
  const update = updater();
  const meter = await createApiRelayMeter({
    request,
    update,
    onError: jest.fn(),
  });
  try {
    expect(await meter.take(500, "sent")).toBe(500);
    expect(await meter.take(800, "received")).toBe(524);
    await expect(meter.take(1, "sent")).rejects.toThrow("quota exhausted");
    await meter.close("quota exhausted");
    await meter.close("quota exhausted");
    expect(update.mock.calls.map(([r]) => r.sequence)).toEqual([0, 1, 2]);
    expect(update.mock.calls.at(-1)?.[0]).toMatchObject({
      sent: 500,
      received: 524,
      close: true,
    });
  } finally {
    await meter.close("test");
  }
});

it("rejects exhausted quota before opening upstream", async () => {
  const update = updater(0);
  await expect(
    createApiRelayMeter({ request, update, onError: jest.fn() }),
  ).rejects.toThrow("quota exhausted");
  expect(update.mock.calls.at(-1)?.[0]).toMatchObject({
    close: true,
    sent: 0,
    received: 0,
  });
});

it("does not replace an uncertain renewal with a different update at the same sequence", async () => {
  const update = updater(10);
  const meter = await createApiRelayMeter({
    request,
    update,
    onError: jest.fn(),
  });
  expect(await meter.take(10, "received")).toBe(10);
  update.mockRejectedValueOnce(Error("transport timeout after commit"));
  await expect(meter.take(1, "received")).rejects.toThrow("timeout");
  await meter.close("failed");
  expect(update).toHaveBeenCalledTimes(2);
});

it("pauses a stream until renewal and never forwards unreserved bytes", async () => {
  const update = updater(10);
  const meter = await createApiRelayMeter({
    request,
    update,
    onError: jest.fn(),
  });
  let renew!: (value: Awaited<ReturnType<typeof update>>) => void;
  update.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        renew = resolve;
      }),
  );
  const stream = meteredStream(meter, "received");
  let bytes = 0;
  stream.on("data", (chunk) => {
    bytes += chunk.length;
  });
  stream.end(Buffer.alloc(20));
  await new Promise((resolve) => setImmediate(resolve));
  expect(bytes).toBe(10);
  renew({ account_id: "a", allowance: 20, expires_at: Date.now() + 60_000 });
  await once(stream, "end");
  expect(bytes).toBe(20);
  await meter.close("completed");
});

it("terminates idle sessions when a periodic renewal exhausts quota", async () => {
  jest.useFakeTimers();
  const update = updater(1024);
  const onError = jest.fn();
  const meter = await createApiRelayMeter({
    request,
    update,
    onError,
    intervalMs: 100,
  });
  try {
    await meter.take(10, "sent");
    update.mockResolvedValueOnce({
      account_id: "a",
      allowance: 10,
      expires_at: Date.now() + 60_000,
    });
    await jest.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 429 }),
    );
    await expect(meter.take(1, "received")).rejects.toThrow("quota exhausted");
    await meter.close("quota exhausted");
  } finally {
    jest.useRealTimers();
  }
});

it("does not spend expired credit while a renewal is unavailable", async () => {
  jest.useFakeTimers();
  const update = updater(1024);
  const meter = await createApiRelayMeter({
    request,
    update,
    onError: jest.fn(),
    intervalMs: 120_000,
  });
  try {
    expect(await meter.take(10, "sent")).toBe(10);
    jest.setSystemTime(Date.now() + 60_001);
    update.mockRejectedValueOnce(Error("quota service unavailable"));
    await expect(meter.take(10, "received")).rejects.toThrow("unavailable");
    await meter.close("renewal failed");
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][0]).toMatchObject({
      sequence: 1,
      sent: 10,
      received: 0,
    });
  } finally {
    await meter.close("test");
    jest.useRealTimers();
  }
});
