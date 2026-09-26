import { PassThrough } from "node:stream";
import { getClaudeSubscriptionUsage } from "./claude-subscription-usage";
import { getClaudeSubscriptionCredential } from "./claude-subscription-registry";
import { launchClaudeSubscriptionController } from "./claude-subscription-controller";
import { parseClaudeSubscriptionUsage } from "@cocalc/util/ai/claude-usage";

jest.mock("./claude-subscription-registry", () => ({
  getClaudeSubscriptionCredential: jest.fn(async () => ({})),
}));
jest.mock("./claude-subscription-controller", () => ({
  launchClaudeSubscriptionController: jest.fn(),
}));
const credential = jest.mocked(getClaudeSubscriptionCredential);
const launch = jest.mocked(launchClaudeSubscriptionController);
let counter = 0;
const options = () => ({
  projectId: "project",
  accountId: "account",
  credentialId: `credential-${counter++}`,
});
const limits = {
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 8, resets_at: "2026-09-26T15:00:00Z" },
    seven_day: { utilization: 1, resets_at: null },
  },
};

function processResult(output: string) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stop = jest.fn(async () => {});
  const closed = new Promise<void>((resolve) =>
    setTimeout(() => {
      stdout.end(output);
      resolve();
    }, 0),
  );
  launch.mockResolvedValueOnce({
    stdout,
    stderr,
    stdin: new PassThrough(),
    stop,
    closed,
  });
  return stop;
}

beforeEach(() => {
  jest.clearAllMocks();
});

test("usage is sanitized, isolated, cached and reauthorized on cache hits", async () => {
  const opts = options();
  const stop = processResult(
    JSON.stringify({
      ...limits,
      secret: "never-forward",
      session: { raw: "private" },
    }),
  );
  const usage = await getClaudeSubscriptionUsage(opts);
  expect(usage.available).toBe(true);
  expect(usage.windows.map(({ usedPercent }) => usedPercent)).toEqual([8, 1]);
  expect(JSON.stringify(usage)).not.toMatch(/never-forward|private/);
  expect(launch).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: "account",
      credential: expect.objectContaining({ credentialId: opts.credentialId }),
    }),
    "usage",
  );
  expect(stop).toHaveBeenCalledTimes(1);
  expect(await getClaudeSubscriptionUsage(opts)).toEqual(usage);
  expect(launch).toHaveBeenCalledTimes(1);
  expect(credential).toHaveBeenCalledTimes(2);
  credential.mockRejectedValueOnce(Error("revoked"));
  await expect(getClaudeSubscriptionUsage(opts)).rejects.toThrow("revoked");
  expect(launch).toHaveBeenCalledTimes(1);
});

test("account and project scopes cannot reuse another usage result", async () => {
  const opts = options();
  processResult(JSON.stringify(limits));
  await getClaudeSubscriptionUsage(opts);
  credential.mockRejectedValueOnce(Error("wrong owner"));
  await expect(
    getClaudeSubscriptionUsage({ ...opts, accountId: "other" }),
  ).rejects.toThrow("wrong owner");
  expect(launch).toHaveBeenCalledTimes(1);
});

test.each(["private provider error", "x".repeat(256 * 1024 + 1)])(
  "invalid or oversized output is never returned and controller is stopped",
  async (raw) => {
    const stop = processResult(raw);
    await expect(getClaudeSubscriptionUsage(options())).rejects.not.toThrow(
      "private provider error",
    );
    expect(stop).toHaveBeenCalledTimes(1);
  },
);

test("missing, invalid and API-billed limits are unknown, not zero usage", () => {
  for (const value of [
    undefined,
    {},
    { ...limits, rate_limits_available: false },
    {
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: -1 },
        seven_day: { utilization: "7" },
      },
    },
  ]) {
    expect(parseClaudeSubscriptionUsage(value)).toMatchObject({
      available: false,
      windows: [],
    });
  }
  expect(
    parseClaudeSubscriptionUsage({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 0, resets_at: "bad date" } },
    }).windows,
  ).toEqual([{ name: "Current session (5 hours)", usedPercent: 0 }]);
});
