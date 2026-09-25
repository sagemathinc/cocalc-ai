import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import { ONBOARDING_METRICS as M } from "@cocalc/util/onboarding-metrics";
import {
  ensureUxLatencySchema,
  recordUxLatencyEvent,
  sweepIncompleteOnboardingAttempts,
} from "./ux-latency";

jest.mock("./ux-saturation", () => ({
  getUxSaturationContext: async () => ({}),
}));
beforeAll(async () => {
  await before({ noConat: true });
  await ensureUxLatencySchema();
}, 30000);
afterAll(after);
beforeEach(async () => {
  await getPool().query("DELETE FROM ux_latency_events");
});

async function event(
  account: string,
  attempt: string,
  metric: string,
  phase = "workspace",
  duration = 0,
) {
  await recordUxLatencyEvent({
    account_id: account,
    event: {
      event_type: "onboarding",
      metric,
      client_event_id: attempt,
      duration_ms: duration,
      started_at: new Date().toISOString(),
      segment: metric === M.phase ? phase : undefined,
      details: { phase },
    },
  });
}
async function ageStarts() {
  await getPool().query(
    "UPDATE ux_latency_events SET received_at = NOW() - INTERVAL '3 minutes' WHERE metric = $1",
    [M.started],
  );
}

it("records a disappeared browser once, retaining its latest phase", async () => {
  const account = uuid(),
    attempt = uuid();
  await event(account, attempt, M.started);
  await event(account, attempt, M.phase, "starting", 1000);
  await event(account, attempt, M.phase, "identity", 2000);
  await ageStarts();
  expect(await sweepIncompleteOnboardingAttempts()).toBe(1);
  expect(await sweepIncompleteOnboardingAttempts()).toBe(0);
  const { rows } = await getPool().query(
    "SELECT * FROM ux_latency_events WHERE metric = $1",
    [M.incomplete],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].details).toEqual({
    phase: "identity",
    reason: "server_deadline_no_terminal_event",
  });
  expect(rows[0].duration_ms).toBeGreaterThanOrEqual(120000);
});

it.each([M.visible, M.failed, M.abandoned])(
  "does not label an acknowledged %s outcome incomplete",
  async (terminal) => {
    const account = uuid(),
      attempt = uuid();
    await event(account, attempt, M.started);
    await event(account, attempt, terminal);
    await ageStarts();
    expect(await sweepIncompleteOnboardingAttempts()).toBe(0);
  },
);

it("does not count outbox retries twice and isolates attempts by account", async () => {
  const account = uuid(),
    other = uuid(),
    attempt = uuid();
  await event(account, attempt, M.started);
  await event(account, attempt, M.started);
  await event(other, attempt, M.started);
  await event(other, attempt, M.visible);
  await ageStarts();
  expect(await sweepIncompleteOnboardingAttempts()).toBe(1);
  const { rows } = await getPool().query(
    "SELECT account_id FROM ux_latency_events WHERE metric = $1",
    [M.incomplete],
  );
  expect(rows).toEqual([{ account_id: account }]);
});

it("allows late success without erasing evidence of the missed deadline", async () => {
  const account = uuid(),
    attempt = uuid();
  await event(account, attempt, M.started);
  expect(await sweepIncompleteOnboardingAttempts()).toBe(0);
  await ageStarts();
  await sweepIncompleteOnboardingAttempts();
  await event(account, attempt, M.visible, "output", 190000);
  const { rows } = await getPool().query(
    "SELECT metric FROM ux_latency_events ORDER BY received_at",
  );
  expect(rows.map((r) => r.metric)).toEqual([
    M.started,
    M.incomplete,
    M.visible,
  ]);
});
