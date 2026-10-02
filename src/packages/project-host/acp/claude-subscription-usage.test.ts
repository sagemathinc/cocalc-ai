import { createClaudeUsageRecorder } from "./claude-subscription-usage";

const projectId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const credentialId = "00000000-0000-4000-8000-000000000003";

function info(utilization: number) {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  return { unifiedWindows: { five_hour: { utilization, resetsAt } } };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("saves the first report now and later ones at most every interval", async () => {
  const write = jest.fn(async () => {});
  const record = createClaudeUsageRecorder({ write, minIntervalMs: 30_000 });
  record({ projectId, accountId, credentialId, info: info(0.1) });
  await jest.advanceTimersByTimeAsync(0);
  expect(write).toHaveBeenCalledTimes(1);
  record({ projectId, accountId, credentialId, info: info(0.2) });
  record({ projectId, accountId, credentialId, info: info(0.3) });
  await jest.advanceTimersByTimeAsync(29_000);
  expect(write).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1_000);
  expect(write).toHaveBeenCalledTimes(2);
  // Only the latest report is saved.
  expect(
    (write.mock.calls[1] as any)[0].usage.windows.five_hour.utilization,
  ).toBe(0.3);
});

test("ignores reports without limits and invalid bindings", async () => {
  const write = jest.fn(async () => {});
  const record = createClaudeUsageRecorder({ write });
  record({ projectId, accountId, credentialId, info: { status: "allowed" } });
  record({ projectId, accountId: "nope", credentialId, info: info(0.1) });
  await jest.advanceTimersByTimeAsync(60_000);
  expect(write).not.toHaveBeenCalled();
});
