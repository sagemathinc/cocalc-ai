import type { HostConatPersistMetrics } from "@cocalc/conat/hub/api/hosts";
import {
  persistenceAlert,
  persistenceAlertDelivery,
} from "./persistence-alert-policy";

const now = Date.parse("2026-09-10T18:00:00Z");
const GIB = 1024 ** 3;
function history(
  change: (ageMinutes: number) => Partial<HostConatPersistMetrics> = () => ({}),
): HostConatPersistMetrics[] {
  return Array.from({ length: 36 }, (_, age) => ({
    schema_version: 1,
    collected_at: new Date(now - age * 60_000).toISOString(),
    available: true,
    ready: true,
    pid: 10,
    uptime_seconds: 10000 - age * 60,
    rss_bytes: GIB,
    diagnostics_duration_ms: 100,
    open_streams: 2200,
    ...change(age),
  }));
}

describe("persistence alert policy", () => {
  it("keeps even large and growing stream counts informational", () => {
    expect(
      persistenceAlert(
        history((age) => ({ open_streams: 100000 - age * 1000 })),
        now,
      ),
    ).toBeUndefined();
  });

  it("requires sustained warning RSS and recovers immediately on a good sample", () => {
    expect(
      persistenceAlert(
        history((age) => ({ rss_bytes: age < 10 ? 3 * GIB : GIB })),
        now,
      ),
    ).toBeUndefined();
    expect(
      persistenceAlert(
        history(() => ({ rss_bytes: 3 * GIB })),
        now,
      ),
    ).toMatchObject({ level: "warning", signal: "rss" });
    expect(
      persistenceAlert(
        history((age) => ({ rss_bytes: age === 0 ? GIB : 3 * GIB })),
        now,
      ),
    ).toBeUndefined();
  });

  it("confirms critical RSS over two minutes, not one spike", () => {
    expect(
      persistenceAlert(
        history((age) => ({ rss_bytes: age < 2 ? 5 * GIB : GIB })),
        now,
      ),
    ).toBeUndefined();
    expect(
      persistenceAlert(
        history((age) => ({ rss_bytes: age <= 2 ? 5 * GIB : GIB })),
        now,
      ),
    ).toMatchObject({ level: "critical", signal: "rss" });
  });

  it.each([{ available: false }, { ready: false }])(
    "detects repeated failed health checks %j",
    (failure) => {
      expect(
        persistenceAlert(
          history((age) => (age <= 2 ? failure : {})),
          now,
        ),
      ).toMatchObject({ level: "critical", signal: "health" });
      expect(
        persistenceAlert(
          history((age) => (age === 0 ? failure : {})),
          now,
        ),
      ).toBeUndefined();
    },
  );

  it("requires sustained slow diagnostics and labels the latency correctly", () => {
    expect(
      persistenceAlert(
        history((age) => ({ diagnostics_duration_ms: age < 10 ? 2500 : 100 })),
        now,
      ),
    ).toBeUndefined();
    expect(
      persistenceAlert(
        history(() => ({ diagnostics_duration_ms: 2500 })),
        now,
      ),
    ).toMatchObject({
      signal: "diagnostics",
      reason: expect.stringContaining("not a user-request latency"),
    });
  });

  it("detects sustained material RSS growth below the static warning threshold", () => {
    expect(
      persistenceAlert(
        history((age) => ({ rss_bytes: (1.8 - age * 0.025) * GIB })),
        now,
      ),
    ).toMatchObject({ signal: "growth" });
    expect(
      persistenceAlert(
        history((age) => ({ rss_bytes: (age < 15 ? 1.8 : 1) * GIB })),
        now,
      ),
    ).toBeUndefined();
    expect(
      persistenceAlert(
        history((age) => ({ rss_bytes: (1.8 - age * 0.001) * GIB })),
        now,
      ),
    ).toBeUndefined();
  });

  it("does not carry memory evidence across a restart, including PID reuse", () => {
    expect(
      persistenceAlert(
        history((age) => ({ rss_bytes: 3 * GIB, pid: age < 8 ? 10 : 11 })),
        now,
      ),
    ).toBeUndefined();
    expect(
      persistenceAlert(
        history((age) => ({
          rss_bytes: 3 * GIB,
          uptime_seconds: age < 8 ? 500 - age * 60 : 10000 - age * 60,
        })),
        now,
      ),
    ).toBeUndefined();
  });

  it("requires recent, distinct observations without large gaps", () => {
    const samples = history(() => ({ rss_bytes: 3 * GIB }));
    expect(persistenceAlert(samples.slice(6), now)).toBeUndefined();
    expect(
      persistenceAlert(
        samples.filter((_, i) => i === 0 || i > 5),
        now,
      ),
    ).toBeUndefined();
    expect(persistenceAlert(Array(20).fill(samples[0]), now)).toBeUndefined();
    expect(
      persistenceAlert(
        samples.map((s) => ({ ...s, collected_at: "invalid" })),
        now,
      ),
    ).toBeUndefined();
    expect(persistenceAlert([null], now)).toBeUndefined();
  });

  it("does not interpret invalid counters as pressure", () => {
    expect(
      persistenceAlert(
        history(() => ({ rss_bytes: NaN, diagnostics_duration_ms: Infinity })),
        now,
      ),
    ).toBeUndefined();
  });

  it("deduplicates stable host/signal/severity identities, not metric values", () => {
    const alert = { level: "warning", signal: "rss", reason: "first" } as const;
    const delivery = persistenceAlertDelivery("host-a", alert);
    expect(delivery).toMatchObject({ dedupMinutes: 240, dedupBySubject: true });
    expect(
      persistenceAlertDelivery("host-a", { ...alert, reason: "changed" }),
    ).toEqual(delivery);
    expect(persistenceAlertDelivery("host-b", alert).subject).not.toEqual(
      delivery.subject,
    );
    const critical = persistenceAlertDelivery("host-a", {
      ...alert,
      level: "critical",
    });
    expect(critical.subject).not.toEqual(delivery.subject);
    expect(critical.dedupMinutes).toBe(60);
    expect(
      persistenceAlertDelivery("host-a", { ...alert, signal: "health" })
        .subject,
    ).not.toEqual(delivery.subject);
  });
});
