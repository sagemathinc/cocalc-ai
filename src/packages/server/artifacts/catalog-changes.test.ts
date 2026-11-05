import { randomUUID } from "node:crypto";
import {
  ARTIFACT_CATALOG_DELTAS_UNAVAILABLE,
  artifactCatalogHintBackoffMs,
  deliverArtifactCatalogHint,
  listChanges,
  listChangesOwnedControl,
  startArtifactCatalogHintDrainer,
  type HintDeps,
} from "./catalog-changes";
import { nudgeArtifactCatalogHints } from "./catalog-readiness";
import { resetArtifactCatalogReadLimitsForTests } from "./catalog-read-limits";

const NOT_PERMITTED = "not found or not permitted";
let banned = false;
let validated = true;
const resolveProjectBay = jest.fn();
const authorized = jest.fn();
const read = jest.fn();
const hintsDue = jest.fn();
const remote = { listChanges: jest.fn() };
const mockUndeliverable = { inc: jest.fn() };

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "here",
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...a) => resolveProjectBay(...a),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => "trusted-fabric",
}));
jest.mock("@cocalc/conat/inter-bay/artifact-catalog", () => ({
  createInterBayArtifactCatalogClient: () => remote,
}));
jest.mock("@cocalc/server/accounts/security-state", () => ({
  ensureAccountSecurityStateReady: async () => {},
  isAccountBannedCached: () => banned,
}));
jest.mock("@cocalc/backend/metrics", () => ({
  newCounter: () => mockUndeliverable,
  newGauge: () => ({ set: () => {} }),
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => "pool",
}));
jest.mock("@cocalc/server/conat/api/browser-sessions-live", () => ({
  listLiveBrowserSessionAccountIds: async () => [],
}));
jest.mock("@cocalc/server/account/feed", () => ({
  publishAccountFeedEvent: jest.fn(),
}));
jest.mock("@cocalc/database/postgres/artifact-catalog-read", () => ({
  ARTIFACT_CATALOG_NOT_PERMITTED: "not found or not permitted",
  ARTIFACT_CATALOG_READ_GROUPS: ["owner", "collaborator"],
  authorizedArtifactCatalogProjects: (...a) => authorized(...a),
}));
jest.mock("@cocalc/database/postgres/artifact-catalog-changes", () => ({
  ...jest.requireActual("@cocalc/database/postgres/artifact-catalog-changes"),
  readArtifactCatalogChangesForAccount: (...a) => read(...a),
  artifactCatalogHintsDue: (...a) => hintsDue(...a),
}));
jest.mock("./catalog-readiness", () => ({
  ...jest.requireActual("./catalog-readiness"),
  artifactCatalogDeltasReady: async () => validated,
}));

const account_id = randomUUID();
const project_id = randomUUID();
const from = { epoch: randomUUID(), seq: 3 };
const page = {
  from_seq: 3,
  through_seq: 4,
  current: { epoch: from.epoch, seq: 4 },
  upserts: [],
  removes: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  resetArtifactCatalogReadLimitsForTests();
  banned = false;
  validated = true;
  resolveProjectBay.mockResolvedValue({ bay_id: "here", epoch: 1 });
  authorized.mockImplementation(
    async (_db, { project_ids }) => new Set(project_ids),
  );
  read.mockResolvedValue(page);
});

describe("listChanges at the hub (P1)", () => {
  test("the whole request is validated before any routing", async () => {
    for (const bad of [
      { project_id: "x", from },
      { project_id, from: { epoch: "e", seq: 1 } },
      { project_id, from: { ...from, seq: -1 } },
      { project_id, from, through_seq: 2 },
      { project_id, from, after_entry: "a".repeat(64) },
    ])
      await expect(
        listChanges({ account_id, ...(bad as any) }),
      ).rejects.toThrow("invalid catalog change request");
    expect(resolveProjectBay).not.toHaveBeenCalled();
  });

  test("an unresolved project gets the uniform refusal; a remote one goes to its bay", async () => {
    resolveProjectBay.mockResolvedValueOnce(undefined);
    await expect(listChanges({ account_id, project_id, from })).rejects.toThrow(
      NOT_PERMITTED,
    );
    resolveProjectBay.mockResolvedValueOnce({ bay_id: "there", epoch: 1 });
    remote.listChanges.mockResolvedValue(page);
    await listChanges({ account_id, project_id, from, through_seq: 4 });
    expect(remote.listChanges).toHaveBeenCalledWith({
      account_id,
      project_id,
      from,
      through_seq: 4,
    });
  });
});

describe("listChanges on the owner bay (B1, B3, R2)", () => {
  test("unauthorized gets the uniform refusal even where deltas are not served", async () => {
    validated = false;
    authorized.mockResolvedValue(new Set());
    await expect(
      listChangesOwnedControl({ account_id, project_id, from }),
    ).rejects.toThrow(NOT_PERMITTED);
    expect(read).not.toHaveBeenCalled();
  });

  test("an authorized reader learns only that deltas are unavailable here", async () => {
    validated = false;
    await expect(
      listChangesOwnedControl({ account_id, project_id, from }),
    ).rejects.toThrow(ARTIFACT_CATALOG_DELTAS_UNAVAILABLE);
    expect(read).not.toHaveBeenCalled();
  });

  test("access revoked during the read returns nothing", async () => {
    authorized
      .mockResolvedValueOnce(new Set([project_id]))
      .mockResolvedValueOnce(new Set());
    await expect(
      listChangesOwnedControl({ account_id, project_id, from }),
    ).rejects.toThrow(NOT_PERMITTED);
  });

  test("a banned reader gets the uniform refusal", async () => {
    banned = true;
    await expect(
      listChangesOwnedControl({ account_id, project_id, from }),
    ).rejects.toThrow(NOT_PERMITTED);
  });

  test("the owning bay comes from configuration", async () => {
    expect(
      await listChangesOwnedControl({ account_id, project_id, from }),
    ).toBe(page);
    expect(read).toHaveBeenCalledWith({
      account_id,
      owning_bay_id: "here",
      request: { project_id, from },
    });
  });
});

describe("hint delivery", () => {
  const claim = {
    project_id,
    token: randomUUID(),
    target_seq: 7,
    epoch: from.epoch,
    attempts: 0,
  };
  function deps(
    over: Partial<HintDeps> = {},
  ): HintDeps & Record<string, jest.Mock> {
    return {
      owning_bay_id: "here",
      liveAccounts: jest.fn(async () => ["a", "b", "c"]),
      recipients: jest.fn(async ({ candidates }) => candidates),
      banned: jest.fn(async (id) => id === "c"),
      publish: jest.fn(async () => {}),
      claim: jest.fn(async () => ({ ...claim })),
      renew: jest.fn(async () => true),
      complete: jest.fn(async () => true),
      fail: jest.fn(async () => true),
      now: () => 1234,
      ...over,
    } as any;
  }

  test("every current reader with a live session gets {project, epoch, seq}; banned ones none (P3)", async () => {
    const d = deps();
    expect(await deliverArtifactCatalogHint(project_id, d)).toBe("delivered");
    expect(d.publish.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b"]);
    expect(d.publish.mock.calls[0][1]).toEqual({
      type: "artifact.changed",
      ts: 1234,
      account_id: d.publish.mock.calls[0][0],
      project_id,
      epoch: from.epoch,
      seq: 7,
    });
    expect(d.complete).toHaveBeenCalledTimes(1);
  });

  test("a throwing publisher keeps the target: failure, never success (P6)", async () => {
    const d = deps({
      publish: jest.fn(async (id) => {
        if (id === "b") throw Error("stream publish failed");
      }),
    });
    expect(await deliverArtifactCatalogHint(project_id, d)).toBe("failed");
    expect(d.complete).not.toHaveBeenCalled();
    expect(d.fail).toHaveBeenCalledWith(
      expect.objectContaining({ target_seq: 7 }),
      expect.any(Number),
    );
  });

  test("a failed live lookup or audience query is a failure, not an empty audience (P8)", async () => {
    for (const over of [
      {
        liveAccounts: jest.fn(async () => {
          throw Error("lookup failed");
        }),
      },
      {
        recipients: jest.fn(async () => {
          throw Error("query failed");
        }),
      },
    ]) {
      const d = deps(over as any);
      expect(await deliverArtifactCatalogHint(project_id, d)).toBe("failed");
      expect(d.complete).not.toHaveBeenCalled();
      expect(d.publish).not.toHaveBeenCalled();
    }
    // A successful lookup with nobody live: nothing to tell, so success.
    const empty = deps({ liveAccounts: jest.fn(async () => []) });
    expect(await deliverArtifactCatalogHint(project_id, empty)).toBe(
      "delivered",
    );
  });

  test("the 5th failure gives up with a counts-only metric; a claim at 5 attempts never publishes", async () => {
    const d = deps({
      claim: jest.fn(async () => ({ ...claim, attempts: 4 })),
      publish: jest.fn(async () => {
        throw Error("down");
      }),
    });
    expect(await deliverArtifactCatalogHint(project_id, d)).toBe("gave-up");
    expect(d.complete).toHaveBeenCalled();
    expect(d.fail).not.toHaveBeenCalled();
    expect(mockUndeliverable.inc).toHaveBeenCalledWith();
    const crashed = deps({
      claim: jest.fn(async () => ({ ...claim, attempts: 5 })),
    });
    expect(await deliverArtifactCatalogHint(project_id, crashed)).toBe(
      "gave-up",
    );
    expect(crashed.publish).not.toHaveBeenCalled();
  });

  test("a lost claim (renew fails) stops publishing and changes nothing", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `acct-${i}`);
    const d = deps({
      liveAccounts: jest.fn(async () => many),
      banned: jest.fn(async () => false),
      renew: jest.fn(async () => false),
    });
    expect(await deliverArtifactCatalogHint(project_id, d)).toBe("lost");
    expect(d.publish).toHaveBeenCalledTimes(16);
    expect(d.complete).not.toHaveBeenCalled();
    expect(d.fail).not.toHaveBeenCalled();
  });

  test("nothing due: no claim, no work", async () => {
    const d = deps({ claim: jest.fn(async () => null) });
    expect(await deliverArtifactCatalogHint(project_id, d)).toBe("none");
    expect(d.liveAccounts).not.toHaveBeenCalled();
  });

  test("backoff grows to a 5 minute cap, with jitter", () => {
    expect(artifactCatalogHintBackoffMs(1, () => 0.5)).toBe(2000);
    expect(artifactCatalogHintBackoffMs(20, () => 0.5)).toBe(300_000);
    expect(artifactCatalogHintBackoffMs(2, () => 0)).toBe(3200);
    expect(artifactCatalogHintBackoffMs(2, () => 1)).toBe(4800);
  });
});

describe("the drainer (R3)", () => {
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.COCALC_ARTIFACT_CATALOG_HINTS;
  });

  test("a change whose nudge was lost (made by another worker) is found by the scan", async () => {
    jest.useFakeTimers();
    hintsDue.mockResolvedValue([project_id]);
    const deliver = jest.fn(async () => "delivered" as const);
    const stop = startArtifactCatalogHintDrainer(deliver);
    try {
      await jest.advanceTimersByTimeAsync(4_000);
      expect(deliver).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1_000);
      expect(hintsDue).toHaveBeenCalledWith({
        owning_bay_id: "here",
        limit: 100,
      });
      expect(deliver).toHaveBeenCalledWith(project_id);
    } finally {
      stop();
    }
  });

  test("a nudge after a commit on this worker delivers at once", async () => {
    jest.useFakeTimers();
    hintsDue.mockResolvedValue([project_id]);
    const deliver = jest.fn(async () => "delivered" as const);
    const stop = startArtifactCatalogHintDrainer(deliver);
    try {
      nudgeArtifactCatalogHints();
      await jest.advanceTimersByTimeAsync(0);
      expect(deliver).toHaveBeenCalledWith(project_id);
    } finally {
      stop();
    }
    // Stopped: a later nudge does nothing.
    deliver.mockClear();
    nudgeArtifactCatalogHints();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(deliver).not.toHaveBeenCalled();
  });

  test("hints off on the bay: no drainer", async () => {
    jest.useFakeTimers();
    process.env.COCALC_ARTIFACT_CATALOG_HINTS = "off";
    const deliver = jest.fn();
    startArtifactCatalogHintDrainer(deliver);
    nudgeArtifactCatalogHints();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(hintsDue).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
});
