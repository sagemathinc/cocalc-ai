import {
  listBrowserSessionsForAccount,
  upsertBrowserSessionRecord,
} from "./browser-sessions";

describe("browser session registry merge", () => {
  const account_id = "acct-1";

  it("hides disconnected registry rows immediately when live info is available", () => {
    upsertBrowserSessionRecord({
      account_id,
      browser_id: "browser-disconnected",
      open_projects: [],
    });

    expect(
      listBrowserSessionsForAccount({
        account_id,
        include_stale: false,
        live_by_browser_id: new Map(),
      }),
    ).toEqual([]);

    expect(
      listBrowserSessionsForAccount({
        account_id,
        include_stale: true,
        live_by_browser_id: new Map(),
      }).map(({ browser_id, stale }) => ({ browser_id, stale })),
    ).toEqual([{ browser_id: "browser-disconnected", stale: true }]);
  });

  it("keeps connected registry rows active and merges connection counts", () => {
    upsertBrowserSessionRecord({
      account_id,
      browser_id: "browser-connected",
      open_projects: [],
    });

    expect(
      listBrowserSessionsForAccount({
        account_id,
        include_stale: false,
        live_by_browser_id: new Map([
          [
            "browser-connected",
            { connected: true, connection_count: 2, updated_at_ms: Date.now() },
          ],
        ]),
      }).map(({ browser_id, stale, connected, connection_count }) => ({
        browser_id,
        stale,
        connected,
        connection_count,
      })),
    ).toEqual([
      {
        browser_id: "browser-connected",
        stale: false,
        connected: true,
        connection_count: 2,
      },
    ]);
  });

  it("falls back to age-based staleness when live info is unavailable", () => {
    upsertBrowserSessionRecord({
      account_id,
      browser_id: "browser-fallback",
      open_projects: [],
    });

    expect(
      listBrowserSessionsForAccount({
        account_id,
        include_stale: false,
      }).some(({ browser_id }) => browser_id === "browser-fallback"),
    ).toBe(true);
  });
});
