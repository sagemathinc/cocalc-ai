/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The federated turn against a real (ephemeral) database, with fake host,
// owning-bay and broker dependencies. Fake values only.

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { ensureFederatedConnectorGuards } from "@cocalc/database/postgres/schema/federated-connector-guards";
import { parseFederatedConnectorTurnResult } from "@cocalc/util/ai/federated-connectors";
import type { FederationProjectSnapshot } from "./approvals";
import type { MintRequest, MintResult } from "./broker";
import {
  beginFederatedTurn,
  endFederatedTurn,
  FEDERATED_CONNECTOR_UNAVAILABLE,
  FEDERATED_CONNECTORS_DISABLED,
  FEDERATED_TURN_REFUSED,
  federatedTurnKey,
  parseFederatedTurnRequest,
  countStaleOpenFederatedLeases,
  reconcileFederatedLeases,
  verifyFederatedLiveTurn,
  type FederatedTurnDeps,
} from "./turn";

const UUID = (n: number) =>
  `00000000-0000-4000-8000-${`${n}`.padStart(12, "0")}`;
const ACCOUNT = UUID(1);
const AGENT = UUID(2);
const PROJECT = UUID(3);
const HOST = UUID(4);
const OTHER_HOST = UUID(5);
const CONNECTION = UUID(6);
const GRANT = UUID(7);
const GRANT2 = UUID(8);
const ASSIGNMENT = UUID(9);
const APPROVAL = UUID(10);
let runSeq = 100;

const q = (sql: string, params: any[] = []) => getPool().query(sql, params);

function request(overrides: Record<string, unknown> = {}) {
  return {
    account_id: ACCOUNT,
    host_id: HOST,
    agent_id: AGENT,
    source_project_id: PROJECT,
    run_id: UUID(runSeq),
    turn_ref: {
      chat_path: "agents/a.chat",
      message_date: "2026-11-09T05:00:00.000Z",
      message_id: "m-1",
      thread_id: "t-1",
    },
    ...overrides,
  };
}

const SOLO: FederationProjectSnapshot = {
  owning_bay_id: "bay-a",
  users_revision: 1,
  account_role: "owner",
  other_members: 0,
  pending_invites: 0,
  approval_id: null,
};

let snapshot: FederationProjectSnapshot | Error = SOLO;
let gate: boolean | Error = true;
let authority: Error | undefined;
let mint: (req: MintRequest) => MintResult = (req) => issued(req);
const getToken = jest.fn(async (req: MintRequest) => mint(req));
let tokenCheck: Error | undefined;
const checkIssued = jest.fn(async (_issued: any, _grant: any) => {
  if (tokenCheck) throw tokenCheck;
});

function issued(req: MintRequest): MintResult {
  return {
    status: "issued",
    token: "ya29.fake-token-value",
    expires_at: 1_800_000_000_000,
    grant_revision: req.grant_revision,
    connection_id: CONNECTION,
    project: "fake-project-1",
    sa_label: "ops-reader",
  };
}

const deps: FederatedTurnDeps = {
  assertTrustedSource: async () => {
    if (authority) throw authority;
  },
  verifyActiveAgentRun: async () => {
    if (authority) throw authority;
  },
  assertLiveTurn: async () => {
    if (authority) throw authority;
  },
  gateOpen: async () => {
    if (gate instanceof Error) throw gate;
    return gate;
  },
  snapshot: async () => {
    if (snapshot instanceof Error) throw snapshot;
    return snapshot;
  },
  getToken: (req) => getToken(req),
  checkIssuedToken: (issued, grant) => checkIssued(issued, grant),
  site_id: "fake-site",
};

async function leaseRows() {
  const { rows } = await q(
    `SELECT * FROM federated_connector_turn_leases ORDER BY created_at`,
  );
  return rows;
}

async function setAssignment(grant_id: string, enabled = true) {
  await q(
    `INSERT INTO federated_connector_agent_grants
       (assignment_id, account_id, agent_id, source_project_id, grant_id, enabled, revision)
     VALUES ($1,$2,$3,$4,$5,$6,1)
     ON CONFLICT (assignment_id) DO UPDATE
       SET grant_id=EXCLUDED.grant_id, enabled=EXCLUDED.enabled,
           revision=federated_connector_agent_grants.revision+1`,
    [ASSIGNMENT, ACCOUNT, AGENT, PROJECT, grant_id, enabled],
  );
}

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => undefined,
    (e) => e,
  );
  expect(err).toBeInstanceOf(Error);
  // Fixed codes only: nothing else in the message.
  expect(err.message).toBe(code);
}

beforeAll(async () => {
  await initEphemeralDatabase({});
  const client = await getPool().connect();
  try {
    await ensureFederatedConnectorGuards(
      client,
      new Set(["federated_connector_turn_leases"]),
    );
  } finally {
    client.release();
  }
  await q(
    `INSERT INTO federated_connector_connections
       (connection_id, account_id, provider, use_case, state)
     VALUES ($1, $2, 'gcp', 'ops', 'enabled')`,
    [CONNECTION, ACCOUNT],
  );
  for (const g of [GRANT, GRANT2]) {
    await q(
      `INSERT INTO federated_connector_grants
         (grant_id, connection_id, account_id, revision, service_account,
          sa_label, target_project, permission_profile, state,
        service_account_unique_id)
       VALUES ($1, $2, $3, 3, 'reader-sa@example-project-1.iam.gserviceaccount.com',
               'ops-reader', 'fake-project-1', 'read-only', 'enabled',
               '111111111111111111111')`,
      [g, CONNECTION, ACCOUNT],
    );
  }
}, 30_000);

afterAll(async () => {
  await getPool().end();
});

beforeEach(async () => {
  runSeq += 1;
  snapshot = SOLO;
  gate = true;
  authority = undefined;
  mint = (req) => issued(req);
  getToken.mockClear();
  checkIssued.mockClear();
  tokenCheck = undefined;
  await setAssignment(GRANT, true);
});

describe("request", () => {
  it.each([
    ["an extra key", { lease_id: UUID(99) }],
    ["a grant", { grant_id: GRANT }],
    ["a bad uuid", { run_id: "x" }],
    [
      "a sensor run",
      {
        turn_ref: {
          chat_path: "a",
          message_date: "d",
          message_id: "m",
          thread_id: "t",
          sensor_run_id: UUID(1),
        },
      },
    ],
    [
      "an empty turn field",
      {
        turn_ref: {
          chat_path: " ",
          message_date: "d",
          message_id: "m",
          thread_id: "t",
        },
      },
    ],
  ])("refuses %s", (_name, overrides) => {
    expect(() => parseFederatedTurnRequest(request(overrides))).toThrow(
      FEDERATED_TURN_REFUSED,
    );
  });

  it("keys the turn injectively", () => {
    const a = federatedTurnKey(
      request({
        turn_ref: {
          chat_path: "a,b",
          message_date: "c",
          message_id: "m",
          thread_id: "t",
        },
      }) as any,
    );
    const b = federatedTurnKey(
      request({
        turn_ref: {
          chat_path: "a",
          message_date: "b,c",
          message_id: "m",
          thread_id: "t",
        },
      }) as any,
    );
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("beginFederatedTurn", () => {
  it("refuses a failed authority check with an error, creating nothing", async () => {
    authority = Error(`host ${OTHER_HOST} may not act for ${ACCOUNT}`);
    const before = (await leaseRows()).length;
    await expectCode(
      beginFederatedTurn(request(), deps),
      FEDERATED_TURN_REFUSED,
    );
    expect((await leaseRows()).length).toBe(before);
    expect(getToken).not.toHaveBeenCalled();
  });

  it("refuses when the gate is off, and is unavailable if it can't be read", async () => {
    gate = false;
    await expectCode(
      beginFederatedTurn(request(), deps),
      FEDERATED_CONNECTORS_DISABLED,
    );
    gate = Error("settings unavailable");
    await expectCode(
      beginFederatedTurn(request(), deps),
      FEDERATED_CONNECTOR_UNAVAILABLE,
    );
  });

  it("fails closed when the owning bay's snapshot fails", async () => {
    snapshot = Error(`owning bay for ${PROJECT} timed out`);
    const before = (await leaseRows()).length;
    await expectCode(
      beginFederatedTurn(request(), deps),
      FEDERATED_CONNECTOR_UNAVAILABLE,
    );
    expect((await leaseRows()).length).toBe(before);
  });

  it("returns empty without an assignment, creating nothing", async () => {
    await setAssignment(GRANT, false);
    const before = (await leaseRows()).length;
    expect(await beginFederatedTurn(request(), deps)).toEqual({
      entries: [],
      revoked: [],
    });
    expect((await leaseRows()).length).toBe(before);
  });

  it("issues one exact entry and reuses the lease for the turn", async () => {
    const req = request();
    const first = await beginFederatedTurn(req, deps);
    const parsed = parseFederatedConnectorTurnResult(first);
    expect(parsed?.entry).toBeDefined();
    expect(first.entries[0]).toEqual({
      connector: "gcloud",
      token: "ya29.fake-token-value",
      expires_at: 1_800_000_000_000,
      description: "gcloud as ops-reader in fake-project-1",
      gcloud: {
        provider_expires_at: 1_800_000_000_000,
        lease_max_expires_at: null,
        status: "active",
        project: "fake-project-1",
        sa_label: "ops-reader",
        lease_id: expect.any(String),
        connection_id: CONNECTION,
        grant_revision: 3,
      },
    });
    const lease_id = first.entries[0].gcloud.lease_id;
    expect(getToken).toHaveBeenCalledWith({
      site_id: "fake-site",
      account_id: ACCOUNT,
      agent_id: AGENT,
      project_id: PROJECT,
      host_id: HOST,
      run_id: req.run_id,
      grant_id: GRANT,
      lease_id,
      grant_revision: 3,
    });
    const again = await beginFederatedTurn(req, deps);
    expect(again.entries[0].gcloud.lease_id).toBe(lease_id);
    // A new turn gets a new lease.
    runSeq += 1;
    const other = await beginFederatedTurn(request(), deps);
    expect(other.entries[0].gcloud.lease_id).not.toBe(lease_id);
  });

  it("checks the issued token against the hub's grant row, not the broker's labels", async () => {
    mint = (req) =>
      ({ ...issued(req), project: "attacker-project-1" }) as MintResult;
    await beginFederatedTurn(request(), deps).catch(() => undefined);
    expect(checkIssued).toHaveBeenCalledWith(
      expect.objectContaining({ project: "attacker-project-1" }),
      {
        service_account: "reader-sa@example-project-1.iam.gserviceaccount.com",
        service_account_unique_id: "111111111111111111111",
        connection_id: CONNECTION,
        target_project: "fake-project-1",
      },
    );
  });

  it("a token failing the check never reaches the host; the lease stays open", async () => {
    const req = request();
    tokenCheck = Error("token_identity ya29.fake-token-value");
    const err = await beginFederatedTurn(req, deps).catch((e) => e);
    expect(err.message).toBe(FEDERATED_CONNECTOR_UNAVAILABLE);
    tokenCheck = undefined;
    const again = await beginFederatedTurn(req, deps);
    expect(again.entries).toHaveLength(1);
  });

  it("concurrent first calls converge on one lease", async () => {
    const req = request();
    const answers = await Promise.all(
      [1, 2, 3].map(() => beginFederatedTurn(req, deps)),
    );
    const ids = new Set(answers.map((a) => a.entries[0].gcloud.lease_id));
    expect(ids.size).toBe(1);
  });

  it("refuses another host's call without touching the lease", async () => {
    const req = request();
    const first = await beginFederatedTurn(req, deps);
    await expectCode(
      beginFederatedTurn({ ...req, host_id: OTHER_HOST }, deps),
      FEDERATED_TURN_REFUSED,
    );
    const again = await beginFederatedTurn(req, deps);
    expect(again.entries[0].gcloud.lease_id).toBe(
      first.entries[0].gcloud.lease_id,
    );
  });

  it("a broker revision denial ends the lease; the tombstone stays", async () => {
    const req = request();
    const first = await beginFederatedTurn(req, deps);
    const lease_id = first.entries[0].gcloud.lease_id;
    mint = () => ({ status: "denied", reason: "revision" });
    expect(await beginFederatedTurn(req, deps)).toEqual({
      entries: [],
      revoked: [{ lease_id, reason: "revision" }],
    });
    mint = (r) => issued(r);
    getToken.mockClear();
    // Never reopened, never a second lease, no broker call.
    expect(await beginFederatedTurn(req, deps)).toEqual({
      entries: [],
      revoked: [{ lease_id, reason: "revision" }],
    });
    expect(getToken).not.toHaveBeenCalled();
  });

  it("other denials end the lease with deny", async () => {
    mint = () => ({ status: "denied", reason: "not_allowlisted" });
    const answer = await beginFederatedTurn(request(), deps);
    expect(answer.revoked[0].reason).toBe("deny");
  });

  it("a broker error is unavailable and keeps the lease open", async () => {
    const req = request();
    const first = await beginFederatedTurn(req, deps);
    mint = () => ({ status: "error", reason: "transient" });
    await expectCode(
      beginFederatedTurn(req, deps),
      FEDERATED_CONNECTOR_UNAVAILABLE,
    );
    mint = (r) => issued(r);
    const again = await beginFederatedTurn(req, deps);
    expect(again.entries[0].gcloud.lease_id).toBe(
      first.entries[0].gcloud.lease_id,
    );
  });

  it("an assignment change ends the lease with revision, never switching grants", async () => {
    const req = request();
    const first = await beginFederatedTurn(req, deps);
    await setAssignment(GRANT2, true);
    expect(await beginFederatedTurn(req, deps)).toEqual({
      entries: [],
      revoked: [
        { lease_id: first.entries[0].gcloud.lease_id, reason: "revision" },
      ],
    });
  });

  it("a removed assignment ends an existing lease", async () => {
    const req = request();
    const first = await beginFederatedTurn(req, deps);
    await q(
      `DELETE FROM federated_connector_agent_grants WHERE assignment_id=$1`,
      [ASSIGNMENT],
    );
    expect((await beginFederatedTurn(req, deps)).revoked).toEqual([
      { lease_id: first.entries[0].gcloud.lease_id, reason: "revision" },
    ]);
  });

  it("a collaborator added mid-turn ends the lease with deny", async () => {
    const req = request();
    const first = await beginFederatedTurn(req, deps);
    snapshot = { ...SOLO, other_members: 1 };
    expect((await beginFederatedTurn(req, deps)).revoked).toEqual([
      { lease_id: first.entries[0].gcloud.lease_id, reason: "deny" },
    ]);
  });

  it.each([
    ["removed", null],
    ["demoted to viewer", "viewer"],
  ])(
    "the connector account %s after the authority check: deny, or empty without a lease",
    async (_name, role) => {
      const req = request();
      const first = await beginFederatedTurn(req, deps);
      snapshot = { ...SOLO, account_role: role as any };
      expect((await beginFederatedTurn(req, deps)).revoked).toEqual([
        { lease_id: first.entries[0].gcloud.lease_id, reason: "deny" },
      ]);
      runSeq += 1;
      const before = (await leaseRows()).length;
      expect(await beginFederatedTurn(request(), deps)).toEqual({
        entries: [],
        revoked: [],
      });
      expect((await leaseRows()).length).toBe(before);
    },
  );

  it("a pending invite counts as shared; no lease is created", async () => {
    snapshot = { ...SOLO, pending_invites: 1 };
    const before = (await leaseRows()).length;
    expect(await beginFederatedTurn(request(), deps)).toEqual({
      entries: [],
      revoked: [],
    });
    expect((await leaseRows()).length).toBe(before);
  });

  it("an approved shared project proceeds; a change of approval mid-turn denies", async () => {
    snapshot = { ...SOLO, other_members: 2, approval_id: APPROVAL };
    const req = request();
    const first = await beginFederatedTurn(req, deps);
    expect(first.entries).toHaveLength(1);
    snapshot = { ...SOLO, other_members: 2, approval_id: UUID(11) };
    expect((await beginFederatedTurn(req, deps)).revoked[0].reason).toBe(
      "deny",
    );
  });

  it("an approval granted mid-turn to a single-user lease denies; a new turn proceeds", async () => {
    const req = request();
    await beginFederatedTurn(req, deps);
    snapshot = { ...SOLO, other_members: 1, approval_id: APPROVAL };
    expect((await beginFederatedTurn(req, deps)).revoked[0].reason).toBe(
      "deny",
    );
    runSeq += 1;
    expect((await beginFederatedTurn(request(), deps)).entries).toHaveLength(1);
  });

  it("never puts planted ids or tokens in error text", async () => {
    const planted = UUID(424242);
    authority = Error(`planted ${planted} ya29.planted-token`);
    const err = await beginFederatedTurn(
      request({ run_id: planted }),
      deps,
    ).catch((e) => e);
    expect(`${err.message}`).toBe(FEDERATED_TURN_REFUSED);
    authority = undefined;
    snapshot = Error(`planted ${planted}`);
    const err2 = await beginFederatedTurn(request(), deps).catch((e) => e);
    expect(`${err2.message}`).not.toContain(planted);
    snapshot = SOLO;
    mint = () => {
      throw Error(`provider said ya29.planted-token for ${planted}`);
    };
    const err3 = await beginFederatedTurn(request(), deps).catch((e) => e);
    expect(`${err3.message}`).toBe(FEDERATED_CONNECTOR_UNAVAILABLE);
  });
});

describe("endFederatedTurn", () => {
  it("ends with expired, idempotently; the tombstone follows", async () => {
    const req = request();
    const first = await beginFederatedTurn(req, deps);
    await expect(endFederatedTurn(req, deps)).resolves.toEqual({});
    await expect(endFederatedTurn(req, deps)).resolves.toEqual({});
    expect(await beginFederatedTurn(req, deps)).toEqual({
      entries: [],
      revoked: [
        { lease_id: first.entries[0].gcloud.lease_id, reason: "expired" },
      ],
    });
  });

  it("refuses another host and leaves the lease open", async () => {
    const req = request();
    await beginFederatedTurn(req, deps);
    await expectCode(
      endFederatedTurn({ ...req, host_id: OTHER_HOST }, deps),
      FEDERATED_TURN_REFUSED,
    );
    expect((await beginFederatedTurn(req, deps)).entries).toHaveLength(1);
  });

  it("is fine for a turn that never had a lease", async () => {
    await expect(endFederatedTurn(request(), deps)).resolves.toEqual({});
  });
});

describe("verifyFederatedLiveTurn (broker recheck)", () => {
  async function mintedRequest(): Promise<MintRequest> {
    await beginFederatedTurn(request(), deps);
    return getToken.mock.calls.at(-1)![0];
  }

  it("passes for the exact open lease", async () => {
    const r = await mintedRequest();
    await expect(verifyFederatedLiveTurn(r, deps)).resolves.toBeUndefined();
  });

  it("refuses a membership change between begin and mint", async () => {
    const r = await mintedRequest();
    snapshot = { ...SOLO, other_members: 1 };
    await expect(verifyFederatedLiveTurn(r, deps)).rejects.toThrow(
      "turn_not_live",
    );
    snapshot = Error("unreachable");
    await expect(verifyFederatedLiveTurn(r, deps)).rejects.toThrow(
      "turn_not_live",
    );
  });

  it.each([null, "viewer"])(
    "refuses when the connector account's role becomes %s between begin and mint",
    async (role) => {
      const r = await mintedRequest();
      snapshot = { ...SOLO, account_role: role as any };
      await expect(verifyFederatedLiveTurn(r, deps)).rejects.toThrow(
        "turn_not_live",
      );
    },
  );

  it("refuses a closed gate, a lost authority, an assignment change and an ended lease", async () => {
    let r = await mintedRequest();
    gate = false;
    await expect(verifyFederatedLiveTurn(r, deps)).rejects.toThrow(
      "turn_not_live",
    );
    gate = true;
    authority = Error("run ended");
    await expect(verifyFederatedLiveTurn(r, deps)).rejects.toThrow(
      "turn_not_live",
    );
    authority = undefined;
    await setAssignment(GRANT2, true);
    await expect(verifyFederatedLiveTurn(r, deps)).rejects.toThrow(
      "turn_not_live",
    );
    await setAssignment(GRANT, true);
    runSeq += 1;
    r = await mintedRequest();
    await q(
      `UPDATE federated_connector_turn_leases SET ended_at=NOW(), end_reason='expired' WHERE lease_id=$1`,
      [r.lease_id],
    );
    await expect(verifyFederatedLiveTurn(r, deps)).rejects.toThrow(
      "turn_not_live",
    );
  });

  it.each([
    ["host_id", OTHER_HOST],
    ["grant_id", GRANT2],
    ["grant_revision", 4],
    ["run_id", UUID(77)],
    ["account_id", UUID(78)],
    ["lease_id", UUID(79)],
  ])(
    "refuses a request whose %s differs from the lease",
    async (key, value) => {
      const r = await mintedRequest();
      await expect(
        verifyFederatedLiveTurn({ ...r, [key]: value } as MintRequest, deps),
      ).rejects.toThrow("turn_not_live");
    },
  );
});

describe("reconcileFederatedLeases", () => {
  it("ends only leases whose run the authority reports ended", async () => {
    await q(
      `UPDATE federated_connector_turn_leases SET ended_at=NOW(), end_reason='expired' WHERE ended_at IS NULL`,
    );
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      runSeq += 1;
      ids.push(
        (await beginFederatedTurn(request(), deps)).entries[0].gcloud.lease_id,
      );
    }
    // Age them past a day (test-only: the created_at binding is guarded).
    await q(
      `ALTER TABLE federated_connector_turn_leases DISABLE TRIGGER federated_connector_turn_leases_row_guard`,
    );
    try {
      await q(
        `UPDATE federated_connector_turn_leases SET created_at = NOW() - INTERVAL '30 hours' WHERE lease_id = ANY($1)`,
        [ids],
      );
    } finally {
      await q(
        `ALTER TABLE federated_connector_turn_leases ENABLE ALWAYS TRIGGER federated_connector_turn_leases_row_guard`,
      );
    }
    const runs = (await leaseRows())
      .filter((r) => ids.includes(r.lease_id))
      .sort((a, b) => ids.indexOf(a.lease_id) - ids.indexOf(b.lease_id))
      .map((r) => r.run_id);
    const activity = new Map([
      [runs[0], "active"],
      [runs[1], "ended"],
    ]);
    const result = await reconcileFederatedLeases({
      runActivity: async ({ run_id }) => {
        const a = activity.get(run_id);
        if (a == null) throw Error("authority unreachable");
        return a as any;
      },
    });
    expect(result).toEqual({ checked: 3, ended: 1 });
    const rows = await leaseRows();
    const reason = (id: string) =>
      rows.find((r) => r.lease_id === id)?.end_reason ?? null;
    // A live turn older than a day is kept; an unknown answer is kept.
    expect(reason(ids[0])).toBeNull();
    expect(reason(ids[1])).toBe("expired");
    expect(reason(ids[2])).toBeNull();
  });
});

describe("reconciliation order and health", () => {
  it("continues after the last checked lease, so active ones can't starve the rest", async () => {
    await q(
      `UPDATE federated_connector_turn_leases SET ended_at=NOW(), end_reason='expired' WHERE ended_at IS NULL`,
    );
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      runSeq += 1;
      ids.push(
        (await beginFederatedTurn(request(), deps)).entries[0].gcloud.lease_id,
      );
    }
    const seen: string[] = [];
    const runActivity = async ({ run_id }: { run_id: string }) => {
      seen.push(run_id);
      return "active" as const;
    };
    const first = await reconcileFederatedLeases({
      runActivity,
      olderThanMs: -60_000,
      limit: 2,
    });
    expect(first.checked).toBe(2);
    expect(first.next).toBeDefined();
    const second = await reconcileFederatedLeases({
      runActivity,
      olderThanMs: -60_000,
      limit: 2,
      after: first.next,
    });
    expect(second.checked).toBe(1);
    expect(second.next).toBeUndefined();
    expect(new Set(seen).size).toBe(3);
  });

  it("advances past more than a page of leases in one millisecond", async () => {
    await q(
      `UPDATE federated_connector_turn_leases SET ended_at=NOW(), end_reason='expired' WHERE ended_at IS NULL`,
    );
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      runSeq += 1;
      ids.push(
        (await beginFederatedTurn(request(), deps)).entries[0].gcloud.lease_id,
      );
    }
    // Same millisecond, distinct microseconds (test-only: created_at is
    // part of the guarded binding).
    await q(
      `ALTER TABLE federated_connector_turn_leases DISABLE TRIGGER federated_connector_turn_leases_row_guard`,
    );
    try {
      for (const [i, id] of ids.entries()) {
        await q(
          `UPDATE federated_connector_turn_leases
              SET created_at = '2026-01-01 00:00:00.000101+00'::timestamptz + ($2::int * INTERVAL '1 microsecond')
            WHERE lease_id=$1`,
          [id, i],
        );
      }
    } finally {
      await q(
        `ALTER TABLE federated_connector_turn_leases ENABLE ALWAYS TRIGGER federated_connector_turn_leases_row_guard`,
      );
    }
    const order = [...ids];
    const seen: string[] = [];
    const runActivity = async ({ run_id }: { run_id: string }) => {
      seen.push(run_id);
      return "active" as const;
    };
    const first = await reconcileFederatedLeases({ runActivity, limit: 2 });
    expect(first.checked).toBe(2);
    expect(first.next?.created_at).toMatch(/\.000102/);
    const second = await reconcileFederatedLeases({
      runActivity,
      limit: 2,
      after: first.next,
    });
    // Exactly the third lease: nothing re-checked, nothing skipped.
    expect(second.checked).toBe(1);
    expect(new Set(seen).size).toBe(3);
    expect(order).toHaveLength(3);
    await q(
      `UPDATE federated_connector_turn_leases SET ended_at=NOW(), end_reason='expired' WHERE lease_id = ANY($1)`,
      [ids],
    );
  });

  it("counts stale open leases (count only)", async () => {
    runSeq += 1;
    const lease_id = (await beginFederatedTurn(request(), deps)).entries[0]
      .gcloud.lease_id;
    expect(await countStaleOpenFederatedLeases(7)).toBe(0);
    expect(await countStaleOpenFederatedLeases(-1)).toBe(1);
    await q(
      `UPDATE federated_connector_turn_leases SET ended_at=NOW(), end_reason='expired' WHERE lease_id=$1`,
      [lease_id],
    );
    expect(await countStaleOpenFederatedLeases(-1)).toBe(0);
  });
});
