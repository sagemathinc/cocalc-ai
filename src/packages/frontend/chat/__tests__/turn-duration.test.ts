import { formatTurnDuration } from "../turn-duration";

describe("formatTurnDuration", () => {
  it("uses the actual assistant history span when a queued turn completed later", () => {
    expect(
      formatTurnDuration({
        startMs: 0,
        history: [
          { date: new Date(3_660_000).toISOString() },
          { date: new Date(3_600_000).toISOString() },
        ],
      }),
    ).toBe("1:00");
  });

  it("falls back to the message start when there is only one history timestamp", () => {
    expect(
      formatTurnDuration({
        startMs: 1_000,
        history: [{ date: new Date(66_000).toISOString() }],
      }),
    ).toBe("1:05");
  });
});
