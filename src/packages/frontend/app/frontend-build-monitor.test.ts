import {
  FORCED_RELOAD_DELAY_MS,
  FORCED_RELOAD_STORAGE_KEY,
  forceReloadIfRequired,
  isFrontendBuildMismatch,
  shouldForceReloadForBuild,
  isLikelyStaleChunkError,
  urlWithoutFrontendRefreshToken,
} from "./frontend-build-monitor";

jest.mock("@cocalc/frontend/alerts", () => ({ alert_message: jest.fn() }));

describe("frontend build monitor", () => {
  const manifest = {
    schema: 1 as const,
    git_revision: "abc",
    build_timestamp: 123,
    build_date: "2026-08-12T00:00:00.000Z",
    fingerprint: "current-build",
  };

  it("detects upgrades and rollbacks by immutable build identity", () => {
    expect(isFrontendBuildMismatch(manifest, "current-build")).toBe(false);
    expect(isFrontendBuildMismatch(manifest, "other-build")).toBe(true);
    expect(isFrontendBuildMismatch(manifest, "N/A")).toBe(false);
  });

  it("recognizes stale runtime and chunk failures", () => {
    expect(isLikelyStaleChunkError(new Error("ChunkLoadError: failed"))).toBe(
      true,
    );
    expect(
      isLikelyStaleChunkError({
        reason: new Error("__webpack_modules__[id] is undefined"),
      }),
    ).toBe(true);
    expect(isLikelyStaleChunkError(new Error("ordinary failure"))).toBe(false);
  });

  it("removes only the one-time frontend refresh token", () => {
    expect(
      urlWithoutFrontendRefreshToken(
        "https://cocalc.example/agents/name?tab=files&_cocalc_refresh=123#log",
      ),
    ).toBe("/agents/name?tab=files#log");
    expect(
      urlWithoutFrontendRefreshToken(
        "https://cocalc.example/agents/name?_cocalc_refresh=123&tab=files",
      ),
    ).toBe("/agents/name?tab=files");
    expect(
      urlWithoutFrontendRefreshToken(
        "https://cocalc.example/agents/name?tab=files#log",
      ),
    ).toBeUndefined();
  });

  it("forces a reload on CoCalc Star when the build changed, once per build", () => {
    const star = { manifest, setupProfile: "star" };
    // a newer or older build on the server: reload
    expect(
      shouldForceReloadForBuild({ ...star, localFingerprint: "other-build" }),
    ).toBe(true);
    // same build: nothing to do
    expect(
      shouldForceReloadForBuild({ ...star, localFingerprint: "current-build" }),
    ).toBe(false);
    // unknown local build: never force
    expect(
      shouldForceReloadForBuild({ ...star, localFingerprint: "N/A" }),
    ).toBe(false);
    // already reloaded for this build in this tab: no loop
    expect(
      shouldForceReloadForBuild({
        ...star,
        localFingerprint: "other-build",
        alreadyReloadedFor: "current-build",
      }),
    ).toBe(false);
    // a later build after that: reload again
    expect(
      shouldForceReloadForBuild({
        ...star,
        localFingerprint: "other-build",
        alreadyReloadedFor: "an-older-build",
      }),
    ).toBe(true);
    // other sites only recommend the reload (the indicator)
    for (const setupProfile of ["", "plus", "cocalc"]) {
      expect(
        shouldForceReloadForBuild({
          manifest,
          setupProfile,
          localFingerprint: "other-build",
        }),
      ).toBe(false);
    }
  });

  describe("forced reload on CoCalc Star", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    function setup(stored: string | null = null) {
      const items = new Map<string, string>();
      if (stored != null) items.set(FORCED_RELOAD_STORAGE_KEY, stored);
      const storage = {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value),
      };
      const notify = jest.fn();
      const reload = jest.fn();
      const opts = {
        setupProfile: "star",
        localFingerprint: "other-build",
        getStorage: () => storage,
        notify,
        reload,
      };
      return { items, notify, reload, opts };
    }

    it("shows the notice, records the build, then reloads after the delay", () => {
      const { items, notify, reload, opts } = setup();
      expect(forceReloadIfRequired(manifest, opts)).toBe(true);
      // the guard is set before the delay, so nothing can schedule twice
      expect(items.get(FORCED_RELOAD_STORAGE_KEY)).toBe("current-build");
      expect(notify).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(FORCED_RELOAD_DELAY_MS - 1);
      expect(reload).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledWith(manifest);
    });

    it("does not schedule a second reload for the same build", () => {
      const { notify, reload, opts } = setup();
      expect(forceReloadIfRequired(manifest, opts)).toBe(true);
      expect(forceReloadIfRequired(manifest, opts)).toBe(false);
      jest.runAllTimers();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("never reloads without session storage", () => {
      const { notify, reload, opts } = setup();
      const noStorage = {
        ...opts,
        getStorage: () => {
          throw new Error("SecurityError");
        },
      };
      expect(forceReloadIfRequired(manifest, noStorage)).toBe(false);
      const readOnly = {
        ...opts,
        getStorage: () => ({
          getItem: () => null,
          setItem: () => {
            throw new Error("QuotaExceededError");
          },
        }),
      };
      expect(forceReloadIfRequired(manifest, readOnly)).toBe(false);
      jest.runAllTimers();
      expect(notify).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    });

    it("still reloads if the notice fails", () => {
      const { reload, opts } = setup();
      const failingNotice = {
        ...opts,
        notify: () => {
          throw new Error("no notification container");
        },
      };
      expect(forceReloadIfRequired(manifest, failingNotice)).toBe(true);
      jest.runAllTimers();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("does nothing on other sites", () => {
      const { notify, reload, opts } = setup();
      expect(
        forceReloadIfRequired(manifest, { ...opts, setupProfile: "plus" }),
      ).toBe(false);
      jest.runAllTimers();
      expect(notify).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    });
  });
});
