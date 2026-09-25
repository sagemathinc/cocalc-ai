const record = jest.fn();
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    account_id: "account",
    conat_client: {
      hub: {
        system: {
          recordUxLatencyEvent: (...args: unknown[]) => record(...args),
        },
      },
    },
  },
}));
jest.mock("./ux-latency-trace", () => ({
  afterNextPaint: (fn: () => void) => {
    fn();
    return () => {};
  },
}));
import {
  configureOnboardingMonitoring,
  flushOnboardingMetrics,
  OnboardingAttempt,
  recordOnboardingOutput,
  failOnboardingMessage,
  resetOnboardingMonitoringForTests,
} from "./onboarding";
import { ONBOARDING_METRICS as M } from "@cocalc/util/onboarding-metrics";

const events = () => record.mock.calls.map(([{ event }]) => event);
const drain = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await flushOnboardingMetrics();
};
beforeEach(() => {
  jest.useFakeTimers();
  resetOnboardingMonitoringForTests();
  localStorage.clear();
  record.mockReset().mockResolvedValue(undefined);
  configureOnboardingMonitoring("account", true);
});
afterEach(() => {
  resetOnboardingMonitoringForTests();
  jest.useRealTimers();
});

it("measures from submit, includes preparation, and finishes only on output paint", async () => {
  const attempt = new OnboardingAttempt("account");
  jest.advanceTimersByTime(7000);
  attempt.mark("identity", "project");
  attempt.attach("message", "project");
  await drain();
  expect(events().some((e) => e.metric === M.visible)).toBe(false);
  jest.advanceTimersByTime(3000);
  recordOnboardingOutput("message");
  recordOnboardingOutput("message");
  await drain();
  expect(events().filter((e) => e.metric === M.visible)).toEqual([
    expect.objectContaining({
      duration_ms: 10000,
      sample_rate: 1,
      details: expect.objectContaining({
        marks: expect.objectContaining({ identity: 7000 }),
      }),
    }),
  ]);
});

it("reports a hung stage without waiting for a resolved promise, then can record late success", async () => {
  const attempt = new OnboardingAttempt("account");
  attempt.mark("chat");
  jest.advanceTimersByTime(60000);
  await drain();
  expect(events()).toContainEqual(
    expect.objectContaining({
      metric: M.stalled,
      details: expect.objectContaining({ phase: "chat" }),
    }),
  );
  attempt.attach("message", "project");
  recordOnboardingOutput("message");
  await drain();
  expect(events()).toContainEqual(
    expect.objectContaining({ metric: M.visible }),
  );
});

it.each(["dispatch", "render"])(
  "records %s errors, not successful output",
  async (source) => {
    const attempt = new OnboardingAttempt("account");
    attempt.attach("message", "project");
    if (source === "dispatch") failOnboardingMessage("message");
    else recordOnboardingOutput("message", true);
    await drain();
    expect(events().filter((e) => e.metric === M.failed)).toHaveLength(1);
    expect(events().filter((e) => e.metric === M.visible)).toHaveLength(0);
  },
);

it("persists events after network failure and replays on the same account after reload", async () => {
  record.mockRejectedValue(new Error("offline"));
  const attempt = new OnboardingAttempt("account");
  attempt.finish("failed", "Error");
  await drain();
  expect(localStorage.length).toBe(2);
  resetOnboardingMonitoringForTests();
  record.mockReset().mockResolvedValue(undefined);
  configureOnboardingMonitoring("another-account", true);
  await drain();
  expect(record).not.toHaveBeenCalled();
  configureOnboardingMonitoring("account", true);
  await drain();
  expect(events().map((e) => e.metric)).toEqual([M.started, M.failed]);
  expect(localStorage.length).toBe(0);
});

it("reports abandonment on pagehide and respects the telemetry switch", async () => {
  new OnboardingAttempt("account");
  window.dispatchEvent(new Event("pagehide"));
  await drain();
  expect(events()).toContainEqual(
    expect.objectContaining({ metric: M.abandoned }),
  );
  configureOnboardingMonitoring("account", false);
  record.mockClear();
  new OnboardingAttempt("account").finish("failed");
  await drain();
  expect(record).not.toHaveBeenCalled();
});
