import { createHubAdmissionDenialRecorder } from "./hub-admission-denials";
import type { ServiceAdmissionDenialEvent } from "@cocalc/conat/admission/denials";

const event: ServiceAdmissionDenialEvent = {
  surface: "hub-conat-api",
  source: "hub-api-account",
  limit: "account",
  current: 256,
  maximum: 256,
  account_id: "account",
  key: "hosts.resolveProject",
  reason: "busy; oldest_ms=100",
  time: 100,
};

describe("bounded hub admission telemetry", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("aggregates changing diagnostics and preserves counts, peaks and times", async () => {
    const record = jest.fn(async (_event: ServiceAdmissionDenialEvent) => {});
    const warn = jest.fn();
    const recorder = createHubAdmissionDenialRecorder({ record, warn });
    recorder.record(event);
    recorder.record({
      ...event,
      reason: "busy; oldest_ms=200",
      current: 300,
      time: 200,
    });
    recorder.record({ ...event, time: 300 });
    expect(record).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 3,
        suppressed_count: 2,
        current: 300,
        first_time: 100,
        last_time: 300,
      }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("caps distinct groups and counts overflow without attributing it to an account", async () => {
    const record = jest.fn(async (_event: ServiceAdmissionDenialEvent) => {});
    const recorder = createHubAdmissionDenialRecorder({
      record,
      warn: jest.fn(),
      maxGroups: 2,
    });
    for (let i = 0; i < 1_000; i++) {
      recorder.record({ ...event, account_id: `account-${i}` });
    }
    await recorder.flush();
    expect(record).toHaveBeenCalledTimes(3);
    expect(record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: "hub-api-telemetry-overflow",
        count: 998,
      }),
    );
    const overflow = record.mock.calls[2][0] as ServiceAdmissionDenialEvent;
    expect(overflow.account_id).toBeUndefined();
    expect(overflow.key).toBeUndefined();
  });

  it("allows only one write in flight and bounds the next buffer while the sink stalls", async () => {
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const record = jest.fn(async (_event: ServiceAdmissionDenialEvent) => {});
    record.mockImplementationOnce(() => stalled);
    const recorder = createHubAdmissionDenialRecorder({
      record,
      warn: jest.fn(),
      maxGroups: 2,
    });
    recorder.record(event);
    const flush = recorder.flush();
    await Promise.resolve();
    for (let i = 0; i < 100; i++) {
      recorder.record({ ...event, key: `method-${i}` });
    }
    await jest.advanceTimersByTimeAsync(60_000);
    expect(record).toHaveBeenCalledTimes(1);
    expect(recorder.flush()).toBe(flush);
    release();
    await flush;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(record).toHaveBeenCalledTimes(4);
    expect(
      record.mock.calls.reduce((sum, [e]) => sum + (e.count ?? 1), 0),
    ).toBe(101);
  });

  it("contains database failures, reports lost counts once, and can flush later events", async () => {
    const record = jest.fn(async (_event: ServiceAdmissionDenialEvent) => {});
    record.mockRejectedValueOnce(new Error("database overloaded"));
    const warn = jest.fn();
    const recorder = createHubAdmissionDenialRecorder({ record, warn });
    recorder.record({ ...event, count: 17 });
    await expect(recorder.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenLastCalledWith(
      "failed to persist aggregated hub.api admission denials",
      { count: 17 },
    );
    recorder.record(event);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("bounds oversized fields before grouping, retaining or logging them", async () => {
    const record = jest.fn(async (_event: ServiceAdmissionDenialEvent) => {});
    const warn = jest.fn();
    const recorder = createHubAdmissionDenialRecorder({ record, warn });
    const huge = "x".repeat(8 * 1024 * 1024);
    for (let i = 0; i < 10; i++) {
      recorder.record({
        ...event,
        key: huge + i,
        subject: huge,
        reason: huge,
        path: huge,
        account_id: huge,
        extra: huge,
      } as ServiceAdmissionDenialEvent);
    }
    await recorder.flush();
    expect(record).toHaveBeenCalledTimes(1);
    const saved = record.mock.calls[0][0];
    expect(saved.count).toBe(10);
    expect(saved.key).toHaveLength(256);
    expect(saved.subject).toHaveLength(512);
    expect(saved.reason).toHaveLength(512);
    expect(saved.path).toHaveLength(1024);
    expect(saved.account_id).toHaveLength(80);
    expect(saved).not.toHaveProperty("extra");
    expect(JSON.stringify(warn.mock.calls).length).toBeLessThan(4096);
  });

  it("enforces the byte budget across both buffers while a sink is stalled", async () => {
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const record = jest.fn(async (_event: ServiceAdmissionDenialEvent) => {});
    record.mockImplementationOnce(() => stalled);
    const warn = jest.fn();
    const recorder = createHubAdmissionDenialRecorder({
      record,
      warn,
      maxBytes: 8192,
    });
    for (let i = 0; i < 50; i++) {
      recorder.record({ ...event, key: `method-${i}` });
    }
    const flush = recorder.flush();
    await Promise.resolve();
    for (let i = 0; i < 50; i++) {
      recorder.record({ ...event, key: `other-${i}` });
    }
    expect(record).toHaveBeenCalledTimes(1);
    release();
    await flush;
    await recorder.flush();
    const saved = record.mock.calls.map(([e]) => e);
    expect(saved.reduce((sum, e) => sum + e.count!, 0)).toBe(100);
    expect(
      saved.filter((e) => e.source === "hub-api-telemetry-overflow"),
    ).toHaveLength(2);
    expect(saved.length).toBeLessThan(10);
    expect(2 * JSON.stringify(saved).length).toBeLessThan(8192);
  });

  it("sends a growing sample to overflow without losing the earlier group count", async () => {
    const record = jest.fn(async (_event: ServiceAdmissionDenialEvent) => {});
    const recorder = createHubAdmissionDenialRecorder({
      record,
      warn: jest.fn(),
      maxBytes: 8192,
    });
    recorder.record(event);
    recorder.record({
      ...event,
      path: "p".repeat(1024),
      reason: "r".repeat(512),
    });
    await recorder.flush();
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls.map(([e]) => e.count)).toEqual([1, 1]);
    expect(record.mock.calls[1][0].source).toBe("hub-api-telemetry-overflow");
  });
});
