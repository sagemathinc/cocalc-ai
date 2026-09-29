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
});
