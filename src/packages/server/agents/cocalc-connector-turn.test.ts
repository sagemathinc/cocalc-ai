/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export {};

const accountId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";
const hostId = "00000000-0000-4000-8000-000000000004";
const runId = "00000000-0000-4000-8000-000000000005";
const idempotencyKey = "00000000-0000-4000-8000-000000000006";
const configId = "00000000-0000-4000-8000-000000000007";
const scope = { version: 1, account: ["project:list"], projects: [] };
const config = { config_id: configId, scope, revision: 2, enabled: true };

const poolQuery = jest.fn();
const clientQuery = jest.fn();
const release = jest.fn();
const sourceHost = jest.fn();
const sourceMember = jest.fn();
const targets = jest.fn();
const liveRun = jest.fn();
const accountHome = jest.fn();
const directory = jest.fn();
const audit = jest.fn();
const trust = jest.fn();
const encrypt = jest.fn();
const decrypt = jest.fn();
const ensureSchema = jest.fn();
const deleteDirectory = jest.fn();
const clusterAccount = jest.fn();
const hostLease = jest.fn();
const identity = jest.fn();
const allocateSequence = jest.fn();
const sourceDelegation = jest.fn();

jest.mock("@cocalc/server/api/project-membership-revocation", () => ({
  assertApiKeyProjectMembership: (...args) => sourceDelegation(...args),
}));

jest.mock("@cocalc/database/postgres/account-rehome-fence", () => ({
  assertAccountNotRehoming: jest.fn(async () => undefined),
}));
jest.mock("@cocalc/server/api/issuance-sequence", () => ({
  allocateApiKeyIssuanceSequence: (...args) => allocateSequence(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: (...args: any[]) => poolQuery(...args),
    connect: async () => ({ query: clientQuery, release }),
  }),
}));
jest.mock("@cocalc/backend/auth/password-hash", () => ({
  __esModule: true,
  default: () => "test-hash",
  verifyPassword: (secret: string, hash: string) =>
    secret.startsWith("test.") && hash === "test-hash",
}));
jest.mock("@cocalc/database/settings/secret-settings", () => ({
  encryptSecretStorageValue: (...args: any[]) => encrypt(...args),
  decryptSecretStorageValue: (...args: any[]) => decrypt(...args),
}));
jest.mock("@cocalc/server/conat/api/project-host-token-auth", () => ({
  assertAccountProjectHostTokenProjectAccess: (...args: any[]) =>
    sourceHost(...args),
}));
jest.mock("@cocalc/server/accounts/trusted-product-access", () => ({
  assertAccountTrustedForProductAccess: (...args: any[]) => trust(...args),
}));
jest.mock("@cocalc/server/api/manage", () => ({
  createApiKeySecret: ({ key_id }) => `test.${key_id}.secret`,
  ensureApiKeysV2Schema: (...args: any[]) => ensureSchema(...args),
  syncAccountApiKeyDirectory: (...args: any[]) => directory(...args),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  deleteClusterAccountApiKeyDirectoryEntry: (...args: any[]) =>
    deleteDirectory(...args),
  getClusterAccountById: (...args: any[]) => clusterAccount(...args),
}));
jest.mock("@cocalc/server/api/scope-project-access", () => ({
  assertProjectFullCollaborator: (...args: any[]) => sourceMember(...args),
  assertScopeProjectsCollaborator: (...args: any[]) => targets(...args),
}));
jest.mock("@cocalc/server/api/api-key-audit", () => ({
  recordApiKeyAuditEvent: (...args: any[]) => audit(...args),
}));
jest.mock("./identity-routing", () => ({
  verifyActiveAgentRun: (...args: any[]) => liveRun(...args),
}));
jest.mock("./api", () => ({
  getIdentity: (...args: any[]) => identity(...args),
}));
const sensorRun = jest.fn();
jest.mock("./sensor-routing", () => ({
  verifySensorRun: (...args: any[]) => sensorRun(...args),
}));
jest.mock("./cocalc-connector-config", () => ({
  assertAccountHome: (...args: any[]) => accountHome(...args),
}));
jest.mock("@cocalc/server/conat/route-client", () => ({
  getExplicitHostControlClient: async () => ({}),
}));
jest.mock("@cocalc/conat/project-host/api", () => ({
  createHostControlClient: () => ({
    verifyActiveAcpConnectorTurn: (...args: any[]) => hostLease(...args),
  }),
}));

const request = {
  account_id: accountId,
  host_id: hostId,
  agent_id: agentId,
  source_project_id: projectId,
  run_id: runId,
  idempotency_key: idempotencyKey,
  turn_ref: {
    chat_path: "work.chat",
    message_date: "2026-09-25T00:00:00.000Z",
    message_id: "message-a",
    thread_id: "thread-a",
  },
};

let savedTurn: any;
let savedKey: any;
let lockedConfig: any;

beforeEach(() => {
  jest.clearAllMocks();
  allocateSequence.mockResolvedValue("9007199254740993");
  savedTurn = undefined;
  savedKey = undefined;
  lockedConfig = config;
  poolQuery.mockImplementation(async (sql) => ({
    rows: `${sql}`.includes("agent_cocalc_connector_configs")
      ? [config]
      : `${sql}`.includes("FROM agent_cocalc_connector_turns") && savedTurn
        ? [savedTurn]
        : [],
  }));
  clientQuery.mockImplementation(async (sql, args) => {
    const text = `${sql}`;
    if (text.includes("FROM agent_cocalc_connector_configs")) {
      return { rows: [lockedConfig] };
    }
    if (text.includes("AS recent_minute")) {
      return {
        rows: [{ active: "0", recent_minute: "0", recent_burst: "0" }],
      };
    }
    if (text.includes("FROM agent_cocalc_connector_turns")) {
      return { rows: savedTurn ? [savedTurn] : [] };
    }
    if (text.includes("DELETE FROM api_keys")) {
      savedKey = undefined;
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("FROM api_keys")) {
      return { rows: savedKey ? [savedKey] : [] };
    }
    if (text.includes("INSERT INTO api_keys")) {
      savedKey = {
        id: 42,
        key_id: args[3],
        hash: args[4],
        scope: JSON.parse(args[6]),
        scope_revision: 1,
        expire: args[1],
      };
      return { rows: [savedKey] };
    }
    if (text.includes("INSERT INTO agent_cocalc_connector_turns")) {
      savedTurn = {
        turn_id: args[0],
        account_id: args[1],
        agent_id: args[2],
        source_project_id: args[3],
        source_host_id: args[4],
        run_id: args[5],
        chat_path: args[7],
        message_date: args[8],
        message_id: args[9],
        thread_id: args[10],
        config_id: args[11],
        config_revision: args[12],
        key_id: args[13],
        secret_ciphertext: args[14],
        expires_at: args[15],
        ended_at: null,
      };
      return { rows: [savedTurn] };
    }
    if (text.includes("UPDATE api_keys SET expire")) {
      if (savedKey) savedKey.expire = args[2];
      return { rows: [], rowCount: savedKey ? 1 : 0 };
    }
    if (text.includes("UPDATE agent_cocalc_connector_turns")) {
      if (text.includes("renewed_at")) {
        savedTurn.expires_at = args[1];
        savedTurn.renewed_at = new Date();
      } else {
        savedTurn.ended_at = new Date();
        savedTurn.secret_ciphertext = "";
      }
      return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  });
  for (const mock of [
    sourceHost,
    sourceMember,
    sourceDelegation,
    targets,
    liveRun,
    accountHome,
    directory,
    audit,
    trust,
    ensureSchema,
    deleteDirectory,
    hostLease,
    sensorRun,
  ]) {
    mock.mockResolvedValue(undefined);
  }
  encrypt.mockImplementation(async (_name, secret) => `encrypted:${secret}`);
  decrypt.mockImplementation(async (_name, ciphertext) => ({
    value: ciphertext.slice("encrypted:".length),
    needsMigration: false,
  }));
  clusterAccount.mockResolvedValue({ home_bay_id: "bay-0" });
  identity.mockResolvedValue({
    path: request.turn_ref.chat_path,
    thread_id: request.turn_ref.thread_id,
  });
});

test("an enabled config atomically binds one ordinary key to a verified run", async () => {
  const { beginManagedCocalcConnectorTurn } =
    await import("./cocalc-connector-turn");
  const issued = await beginManagedCocalcConnectorTurn(request);
  expect(issued).toMatchObject({
    turn_id: savedTurn.turn_id,
    key_id: savedKey.key_id,
    config_id: configId,
    config_revision: 2,
  });
  expect(issued?.secret).toBe(`test.${savedKey.key_id}.secret`);
  expect(sourceHost).toHaveBeenCalledWith({
    account_id: accountId,
    host_id: hostId,
    project_id: projectId,
  });
  expect(liveRun).toHaveBeenCalledWith({
    account_id: accountId,
    agent_id: agentId,
    project_id: projectId,
    run_id: runId,
  });
  expect(clientQuery.mock.calls.map(([sql]) => `${sql}`)).toEqual(
    expect.arrayContaining(["BEGIN", "COMMIT"]),
  );
  expect(directory).toHaveBeenCalledWith(
    expect.objectContaining({ key_id: savedKey.key_id, scope }),
  );
});

test("idempotent retry returns the same key without allocating another", async () => {
  const { beginManagedCocalcConnectorTurn } =
    await import("./cocalc-connector-turn");
  const first = await beginManagedCocalcConnectorTurn(request);
  const second = await beginManagedCocalcConnectorTurn(request);
  expect(second).toEqual(first);
  expect(allocateSequence).toHaveBeenCalledTimes(1);
  expect(
    clientQuery.mock.calls.find(([sql]) =>
      `${sql}`.includes("INSERT INTO api_keys"),
    )?.[1][7],
  ).toBe("9007199254740993");
  expect(
    clientQuery.mock.calls.filter(([sql]) =>
      `${sql}`.includes("INSERT INTO api_keys"),
    ),
  ).toHaveLength(1);
  expect(directory).toHaveBeenCalledTimes(2);
});

test("disabled consent, host mismatch, and revision change cannot issue", async () => {
  const { beginManagedCocalcConnectorTurn } =
    await import("./cocalc-connector-turn");
  poolQuery.mockResolvedValueOnce({ rows: [{ ...config, enabled: false }] });
  await expect(
    beginManagedCocalcConnectorTurn(request),
  ).resolves.toBeUndefined();
  expect(clientQuery).not.toHaveBeenCalled();

  sourceHost.mockRejectedValueOnce(new Error("wrong source host"));
  await expect(beginManagedCocalcConnectorTurn(request)).rejects.toThrow(
    "wrong source host",
  );
  expect(clientQuery).not.toHaveBeenCalled();

  lockedConfig = { ...config, revision: 3 };
  await expect(beginManagedCocalcConnectorTurn(request)).rejects.toThrow(
    "configuration changed",
  );
  expect(clientQuery.mock.calls.map(([sql]) => `${sql}`)).toContain("ROLLBACK");
  expect(directory).not.toHaveBeenCalled();
  expect(savedKey).toBeUndefined();
});

test("revoked ordinary key cannot be resurrected by a trusted retry", async () => {
  const { beginManagedCocalcConnectorTurn } =
    await import("./cocalc-connector-turn");
  await beginManagedCocalcConnectorTurn(request);
  savedKey = undefined;
  directory.mockClear();
  await expect(beginManagedCocalcConnectorTurn(request)).rejects.toThrow(
    "changed or revoked",
  );
  expect(directory).not.toHaveBeenCalled();
});

test("idempotent retry rejects a stored secret that does not match the key", async () => {
  const { beginManagedCocalcConnectorTurn } =
    await import("./cocalc-connector-turn");
  await beginManagedCocalcConnectorTurn(request);
  savedTurn.secret_ciphertext = "encrypted:wrong-secret";
  directory.mockClear();
  await expect(beginManagedCocalcConnectorTurn(request)).rejects.toThrow(
    "credential is unavailable",
  );
  expect(directory).not.toHaveBeenCalled();
});

test("issuance fails closed when the source host cannot attest the live turn", async () => {
  const { beginManagedCocalcConnectorTurn } =
    await import("./cocalc-connector-turn");
  hostLease.mockRejectedValueOnce(
    new Error("active authenticated ACP turn unavailable"),
  );
  await expect(beginManagedCocalcConnectorTurn(request)).rejects.toThrow(
    "active authenticated ACP turn unavailable",
  );
  expect(savedKey).toBeUndefined();
  expect(directory).not.toHaveBeenCalled();
});

test("issuance rejects a turn belonging to another registered agent thread", async () => {
  const { beginManagedCocalcConnectorTurn } =
    await import("./cocalc-connector-turn");
  identity.mockResolvedValueOnce({
    path: "other.chat",
    thread_id: "other-thread",
  });
  await expect(beginManagedCocalcConnectorTurn(request)).rejects.toThrow(
    "ACP turn does not belong to the registered agent",
  );
  expect(hostLease).not.toHaveBeenCalled();
  expect(savedKey).toBeUndefined();
});

test("idempotent retry cannot attach an existing key to another turn", async () => {
  const { beginManagedCocalcConnectorTurn } =
    await import("./cocalc-connector-turn");
  await beginManagedCocalcConnectorTurn(request);
  await expect(
    beginManagedCocalcConnectorTurn({
      ...request,
      turn_ref: { ...request.turn_ref, message_id: "message-b" },
    }),
  ).rejects.toThrow("managed CoCalc connector turn is no longer valid");
});

test("renewal extends the existing key without exposing a new secret", async () => {
  const { beginManagedCocalcConnectorTurn, renewManagedCocalcConnectorTurn } =
    await import("./cocalc-connector-turn");
  const issued = await beginManagedCocalcConnectorTurn(request);
  directory.mockClear();
  const expiry = await renewManagedCocalcConnectorTurn({
    ...request,
    turn_id: issued!.turn_id,
  });
  expect(expiry).toBeGreaterThanOrEqual(issued!.expires_at);
  expect(sourceDelegation).toHaveBeenCalledWith(
    { account_id: accountId, key_id: issued!.key_id, scope_revision: 1 },
    projectId,
  );
  expect(allocateSequence).toHaveBeenCalledTimes(1);
  expect(directory).toHaveBeenCalledWith(
    expect.objectContaining({
      key_id: issued!.key_id,
      expire: savedKey.expire,
    }),
  );
});

test("renewal rejects a source membership loss even after membership is restored", async () => {
  const { beginManagedCocalcConnectorTurn, renewManagedCocalcConnectorTurn } =
    await import("./cocalc-connector-turn");
  const issued = await beginManagedCocalcConnectorTurn(request);
  sourceDelegation.mockRejectedValueOnce(
    new Error("API delegation revoked by membership loss"),
  );
  clientQuery.mockClear();
  directory.mockClear();
  await expect(
    renewManagedCocalcConnectorTurn({ ...request, turn_id: issued!.turn_id }),
  ).rejects.toThrow("revoked by membership loss");
  expect(sourceMember).toHaveBeenCalled();
  expect(clientQuery).not.toHaveBeenCalled();
  expect(directory).not.toHaveBeenCalled();
  expect(savedKey.expire).toEqual(new Date(issued!.expires_at));
});

test("renewal requires the same live ACP turn", async () => {
  const { beginManagedCocalcConnectorTurn, renewManagedCocalcConnectorTurn } =
    await import("./cocalc-connector-turn");
  const issued = await beginManagedCocalcConnectorTurn(request);
  hostLease.mockRejectedValueOnce(
    new Error("active authenticated ACP turn unavailable"),
  );
  await expect(
    renewManagedCocalcConnectorTurn({ ...request, turn_id: issued!.turn_id }),
  ).rejects.toThrow("active authenticated ACP turn unavailable");
  expect(savedKey.expire).toEqual(new Date(issued!.expires_at));
});

test("renewal rolls back when the ordinary key expires during update", async () => {
  const { beginManagedCocalcConnectorTurn, renewManagedCocalcConnectorTurn } =
    await import("./cocalc-connector-turn");
  const issued = await beginManagedCocalcConnectorTurn(request);
  directory.mockClear();
  const original = clientQuery.getMockImplementation()!;
  clientQuery.mockImplementation(async (sql, args) => {
    if (`${sql}`.includes("UPDATE api_keys SET expire")) {
      return { rows: [], rowCount: 0 };
    }
    return await original(sql, args);
  });
  await expect(
    renewManagedCocalcConnectorTurn({ ...request, turn_id: issued!.turn_id }),
  ).rejects.toThrow("expired during renewal");
  expect(directory).not.toHaveBeenCalled();
  expect(clientQuery.mock.calls.map(([sql]) => `${sql}`)).toContain("ROLLBACK");
});

test("ending a turn revokes its ordinary key and tombstones the directory", async () => {
  const { beginManagedCocalcConnectorTurn, endManagedCocalcConnectorTurn } =
    await import("./cocalc-connector-turn");
  const issued = await beginManagedCocalcConnectorTurn(request);
  await endManagedCocalcConnectorTurn({
    ...request,
    turn_id: issued!.turn_id,
  });
  expect(savedKey).toBeUndefined();
  expect(savedTurn.ended_at).toBeInstanceOf(Date);
  expect(deleteDirectory).toHaveBeenCalledWith({
    key_id: issued!.key_id,
    account_id: accountId,
    home_bay_id: "bay-0",
  });
});

test.each([
  ["active", "64"],
  ["recent_minute", "60"],
  ["recent_burst", "10"],
])(
  "issuance rejects the account %s budget before allocating a key",
  async (field, count) => {
    const { beginManagedCocalcConnectorTurn } =
      await import("./cocalc-connector-turn");
    const original = clientQuery.getMockImplementation()!;
    clientQuery.mockImplementation(async (sql, args) => {
      if (`${sql}`.includes("AS recent_minute")) {
        return {
          rows: [
            {
              active: "0",
              recent_minute: "0",
              recent_burst: "0",
              [field]: count,
            },
          ],
        };
      }
      return original(sql, args);
    });
    await expect(beginManagedCocalcConnectorTurn(request)).rejects.toThrow(
      "key limit reached",
    );
    expect(allocateSequence).not.toHaveBeenCalled();
    expect(savedKey).toBeUndefined();
    expect(savedTurn).toBeUndefined();
    expect(directory).not.toHaveBeenCalled();
    expect(clientQuery.mock.calls.map(([sql]) => `${sql}`)).toContain(
      "ROLLBACK",
    );
  },
);

test("throttled renewal still attests the live turn without extending expiry", async () => {
  const { beginManagedCocalcConnectorTurn, renewManagedCocalcConnectorTurn } =
    await import("./cocalc-connector-turn");
  const issued = await beginManagedCocalcConnectorTurn(request);
  const args = { ...request, turn_id: issued!.turn_id };
  const firstExpiry = await renewManagedCocalcConnectorTurn(args);
  clientQuery.mockClear();
  hostLease.mockClear();
  expect(await renewManagedCocalcConnectorTurn(args)).toBe(firstExpiry);
  expect(hostLease).toHaveBeenCalledTimes(1);
  expect(
    clientQuery.mock.calls.some(([sql]) =>
      `${sql}`.includes("UPDATE api_keys SET expire"),
    ),
  ).toBe(false);
  hostLease.mockRejectedValueOnce(new Error("turn finished"));
  await expect(renewManagedCocalcConnectorTurn(args)).rejects.toThrow(
    "turn finished",
  );
  expect(savedKey.expire.valueOf()).toBe(firstExpiry);
});

test("a sensor run gets its key when the project's bay confirms the run is live", async () => {
  const { beginManagedCocalcConnectorTurn } =
    await import("./cocalc-connector-turn");
  const sensorRequest = {
    ...request,
    turn_ref: { ...request.turn_ref, message_id: runId, sensor_run_id: runId },
  };
  const issued = await beginManagedCocalcConnectorTurn(sensorRequest);
  expect(issued?.secret).toMatch(/^test\./);
  expect(sensorRun).toHaveBeenCalledWith({
    account_id: accountId,
    project_id: projectId,
    agent_id: agentId,
    run_id: runId,
  });
  // No chat turn to attest on the host for a sensor run.
  expect(hostLease).not.toHaveBeenCalled();
});

test("a sensor run that is not live, or a mismatched reference, gets nothing", async () => {
  const { beginManagedCocalcConnectorTurn } =
    await import("./cocalc-connector-turn");
  sensorRun.mockRejectedValueOnce(new Error("sensor run is not live"));
  await expect(
    beginManagedCocalcConnectorTurn({
      ...request,
      turn_ref: {
        ...request.turn_ref,
        message_id: runId,
        sensor_run_id: runId,
      },
    }),
  ).rejects.toThrow("sensor run is not live");
  await expect(
    beginManagedCocalcConnectorTurn({
      ...request,
      turn_ref: { ...request.turn_ref, sensor_run_id: runId },
    }),
  ).rejects.toThrow("invalid sensor run reference");
  expect(savedKey).toBeUndefined();
});
