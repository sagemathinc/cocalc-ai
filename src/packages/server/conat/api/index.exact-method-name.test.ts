/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Finding 080: a hub API name with an extra suffix, `group.method.extra`, ran as
// `group.method` while missing every check keyed by the exact name (admission
// and the resolver cap, edge routing, the host software admin gate, log
// labels). Only exact names may get past the entry.

export {};

const executeHubApiCallMock = jest.fn();
const isAdminMock = jest.fn();
const admissionMock = jest.fn();
const registerLocalExecutorMock = jest.fn();

jest.mock("@cocalc/server/accounts/security-state", () => ({
  __esModule: true,
  isAccountBannedCached: () => false,
  startAccountSecurityStateSyncLoop: jest.fn(),
  syncAccountSecurityStateOnce: jest.fn(),
}));
jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));
jest.mock("./edge-routing", () => ({
  __esModule: true,
  executeHubApiCall: (...args: any[]) => executeHubApiCallMock(...args),
  registerHubApiLocalExecutor: (...args: any[]) =>
    registerLocalExecutorMock(...args),
}));
jest.mock("./admission", () => ({
  __esModule: true,
  getHubApiAdmissionDecision: (...args: any[]) => admissionMock(...args),
}));
jest.mock("./ai-sessions", () => ({
  __esModule: true,
  interrupt: jest.fn(),
  interruptAll: jest.fn(),
  list: jest.fn(),
  upsertProjectHostSession: jest.fn(),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const HOST_ID = "22222222-2222-4222-8222-222222222222";
const SUBJECT = `hub.account.${ACCOUNT_ID}.api`;

// A routed method, an admin-gated method and the resolver (its own admission cap).
const BASES: Array<[string, Record<string, unknown>]> = [
  ["projects.stop", { project_id: PROJECT_ID }],
  ["hosts.upgradeHostSoftware", { id: HOST_ID, targets: [] }],
  ["hosts.resolveHostConnection", { host_id: HOST_ID }],
];
const SUFFIXES = [".x", ".", "..", ".stop", ".api"];
const VARIANTS: Array<[string, Record<string, unknown>]> = BASES.flatMap(
  ([name, opts]) =>
    SUFFIXES.map((suffix): [string, Record<string, unknown>] => [
      `${name}${suffix}`,
      opts,
    ]),
);
// Not methods either: inherited property names, a bare group, non-strings.
const NOT_NAMES: unknown[] = [
  "system.toString",
  "system.constructor",
  "__proto__.x",
  "constructor.name",
  "projects",
  "",
  42,
  null,
  undefined,
  { name: "projects.stop" },
];

// Loading ./index is slow the first time; do it once, outside the tests' limit.
beforeAll(async () => {
  await import("./index");
}, 60_000);

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  executeHubApiCallMock.mockReset();
  executeHubApiCallMock.mockResolvedValue({ ok: true });
  isAdminMock.mockReset();
  isAdminMock.mockResolvedValue(true);
  admissionMock.mockReset();
  admissionMock.mockReturnValue({
    allowed: true,
    source: "hub-api",
    maximum: 1000,
  });
});

describe("hub API method names (conat)", () => {
  it("accepts every exact method name and nothing else", async () => {
    const { getHubApiPrincipalPolicies, isHubApiMethodName } =
      await import("@cocalc/conat/hub/api");
    const names = Object.keys(getHubApiPrincipalPolicies());
    expect(names.length).toBeGreaterThan(100);
    for (const name of names) expect(isHubApiMethodName(name)).toBe(true);
    for (const [name] of VARIANTS) expect(isHubApiMethodName(name)).toBe(false);
    for (const name of NOT_NAMES) expect(isHubApiMethodName(name)).toBe(false);
  });

  it.each(VARIANTS)(
    "%s has no policy, no route and no transform",
    async (name) => {
      const { getHubApiPrincipalPolicy, transformArgs } =
        await import("@cocalc/conat/hub/api");
      const { getHubApiRoute } = await import("@cocalc/conat/hub/api/routes");
      expect(getHubApiPrincipalPolicy(name)).toBeUndefined();
      // The exact-name checks never matched these, which is the gap.
      expect(getHubApiRoute(name)).toBeUndefined();
      await expect(
        transformArgs({ name, args: [{}], account_id: ACCOUNT_ID }),
      ).rejects.toMatchObject({
        message: `unknown function '${name}'`,
        code: 400,
      });
    },
  );

  it("echoes only short printable names", async () => {
    const { unknownHubApiFunctionError } =
      await import("@cocalc/conat/hub/api");
    expect(unknownHubApiFunctionError("a.b.c").message).toBe(
      "unknown function 'a.b.c'",
    );
    expect(unknownHubApiFunctionError("a.b\nX").message).toBe(
      "unknown function",
    );
    expect(unknownHubApiFunctionError("x".repeat(201)).message).toBe(
      "unknown function",
    );
    expect(unknownHubApiFunctionError(42).message).toBe("unknown function");
  });
});

describe("hub API entry (server)", () => {
  it.each(VARIANTS)(
    "%s is refused at the message entry, before admission or routing",
    async (name, opts) => {
      const { handleMessage } = await import("./index");
      const respond = jest.fn();
      await handleMessage({
        mesg: { subject: SUBJECT, data: { name, args: [opts] }, respond },
      });
      await flush();
      expect(admissionMock).not.toHaveBeenCalled();
      expect(isAdminMock).not.toHaveBeenCalled();
      expect(executeHubApiCallMock).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(null, {
        noThrow: true,
        headers: {
          error: `unknown function '${name}'`,
          error_attrs: expect.objectContaining({ code: 400 }),
        },
      });
    },
  );

  it.each(NOT_NAMES.map((name) => [name]))(
    "%p is refused at the message entry",
    async (name) => {
      const { handleMessage } = await import("./index");
      const respond = jest.fn();
      await handleMessage({
        mesg: { subject: SUBJECT, data: { name, args: [] }, respond },
      });
      await flush();
      expect(admissionMock).not.toHaveBeenCalled();
      expect(executeHubApiCallMock).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          headers: expect.objectContaining({
            error_attrs: expect.objectContaining({ code: 400 }),
          }),
        }),
      );
    },
  );

  it.each(VARIANTS)(
    "%s is refused by handleApiRequest too",
    async (name, opts) => {
      const { handleApiRequest } = await import("./index");
      const respond = jest.fn(async () => undefined);
      await handleApiRequest({
        request: { name, args: [opts] },
        mesg: { subject: SUBJECT, respond },
      });
      expect(isAdminMock).not.toHaveBeenCalled();
      expect(executeHubApiCallMock).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(null, {
        headers: {
          error: `unknown function '${name}'`,
          error_attrs: expect.objectContaining({ code: 400 }),
        },
      });
    },
  );

  it.each(VARIANTS)(
    "%s is refused by the local executor (other bays, billing authority)",
    async (name, opts) => {
      await import("./index");
      const executor = registerLocalExecutorMock.mock.calls[0]?.[0];
      expect(typeof executor).toBe("function");
      await expect(
        executor({ name, args: [opts], account_id: ACCOUNT_ID }),
      ).rejects.toMatchObject({
        message: `unknown function '${name}'`,
        code: 400,
      });
    },
  );

  it.each(BASES)(
    "the exact name %s still goes through admission and runs",
    async (name, opts) => {
      const { handleMessage } = await import("./index");
      const respond = jest.fn(async () => undefined);
      await handleMessage({
        mesg: { subject: SUBJECT, data: { name, args: [opts] }, respond },
      });
      await flush();
      expect(admissionMock).toHaveBeenCalledWith(
        expect.objectContaining({ key: name }),
      );
      expect(executeHubApiCallMock).toHaveBeenCalledWith(
        expect.objectContaining({ name, account_id: ACCOUNT_ID }),
      );
      expect(respond).toHaveBeenCalledWith(
        { ok: true },
        { headers: undefined },
      );
    },
  );
});
