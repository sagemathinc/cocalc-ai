/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const resolveProjectBay = jest.fn();
const resolveProjectBays = jest.fn();
const forward = jest.fn();
const createInterBayHubApiClient = jest.fn(() => ({ call: forward }));
const isAccountBannedCached = jest.fn(() => false);
const resolveProjectCollabInviteDirectory = jest.fn();
// The owning bay's call record, in memory: each call id runs once.
const recorded = new Map<string, any>();
const runForwardedCallOnce = jest.fn(async ({ call_id, run }) => {
  if (!recorded.has(call_id)) recorded.set(call_id, await run());
  return recorded.get(call_id);
});

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay,
  resolveProjectBays,
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({ fabric: true }),
}));
jest.mock("@cocalc/conat/inter-bay/hub-api", () => ({
  createInterBayHubApiClient,
}));
jest.mock("@cocalc/server/accounts/security-state", () => ({
  isAccountBannedCached,
}));
jest.mock("@cocalc/server/projects/collab-invite-directory", () => ({
  resolveProjectCollabInviteDirectory,
}));
jest.mock("@cocalc/server/inter-bay/forwarded-calls", () => ({
  OUTCOME_UNKNOWN: "OUTCOME_UNKNOWN",
  forwardedCallHash: jest.requireActual(
    "@cocalc/server/inter-bay/forwarded-calls",
  ).forwardedCallHash,
  runForwardedCallOnce,
}));
jest.mock("@cocalc/server/projects/collaborators", () => ({
  hashProjectCollabInviteToken: async (token: string) => `hash:${token}`,
}));

import {
  executeHubApiCall,
  handleForwardedHubApiCall,
  registerHubApiLocalExecutor,
} from "./edge-routing";

const ACCOUNT = "1f8d5b7c-3c55-4a43-9f43-3ef8b2b2d0a1";
const PROJECT = "6b0f0b1e-2a1f-4b7e-8d7c-0c2f8a9b1c3d";
const local = jest.fn(async (call) => ({ ranHere: call.name }));

const routed = (
  args: any[] = [{ project_id: PROJECT, patch: { title: "t" } }],
) => ({
  name: "projects.setProjectMetadata",
  args,
  account_id: ACCOUNT,
  auth_session_hash: "session",
});

beforeEach(() => {
  jest.clearAllMocks();
  recorded.clear();
  registerHubApiLocalExecutor(local);
  isAccountBannedCached.mockReturnValue(false);
});

describe("executeHubApiCall at the edge", () => {
  it("runs a method without a route here", async () => {
    const call = { name: "projects.listAccountProjectWindow", args: [{}] };
    expect(await executeHubApiCall(call)).toEqual({
      ranHere: call.name,
    });
    expect(resolveProjectBay).not.toHaveBeenCalled();
  });

  it("runs a routed method here when this bay owns the project", async () => {
    resolveProjectBay.mockResolvedValue({ bay_id: "bay-0", epoch: 0 });
    await executeHubApiCall(routed());
    expect(local).toHaveBeenCalledTimes(1);
    expect(forward).not.toHaveBeenCalled();
  });

  it("runs a malformed routed call here, where the method rejects it", async () => {
    await executeHubApiCall(routed([{ project_id: "nope" }]));
    expect(resolveProjectBay).not.toHaveBeenCalled();
    expect(local).toHaveBeenCalledTimes(1);
  });

  it("forwards the whole authenticated call to the owning bay once", async () => {
    resolveProjectBay.mockResolvedValue({ bay_id: "bay-1", epoch: 0 });
    forward.mockResolvedValue({ ok: true, result: { done: true } });
    expect(await executeHubApiCall(routed())).toEqual({ done: true });
    expect(createInterBayHubApiClient).toHaveBeenCalledWith(
      expect.objectContaining({ bay_id: "bay-1" }),
    );
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith({
      ...routed(),
      source_bay_id: "bay-0",
      call_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(local).not.toHaveBeenCalled();
  });

  it("sends an unanswered call again with the same call id", async () => {
    resolveProjectBay.mockResolvedValue({ bay_id: "bay-1", epoch: 0 });
    forward
      .mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: 408 }))
      .mockResolvedValueOnce({ ok: true, result: { done: true } });
    expect(await executeHubApiCall(routed())).toEqual({ done: true });
    expect(forward).toHaveBeenCalledTimes(2);
    const [first, second] = forward.mock.calls.map(([call]) => call.call_id);
    expect(second).toBe(first);
  });

  it("says the outcome is unknown when the owning bay never answers", async () => {
    resolveProjectBay.mockResolvedValue({ bay_id: "bay-1", epoch: 0 });
    forward.mockRejectedValue(
      Object.assign(new Error("timeout"), { code: 408 }),
    );
    await expect(executeHubApiCall(routed())).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      message: expect.stringContaining("may or may not have been applied"),
    });
    expect(forward).toHaveBeenCalledTimes(2);
  });

  it("does not treat a final 503 as proof the call never ran", async () => {
    // The transport retries an unacknowledged fast request over its fallback
    // path, which may then report 503 although the first one was delivered.
    resolveProjectBay.mockResolvedValue({ bay_id: "bay-1", epoch: 0 });
    forward
      .mockRejectedValueOnce(
        Object.assign(new Error("socket has been disconnected"), {
          code: "CONNECTION_LOST",
        }),
      )
      .mockRejectedValue(
        Object.assign(new Error("no subscribers"), { code: 503 }),
      );
    await expect(executeHubApiCall(routed())).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    expect(forward).toHaveBeenCalledTimes(2);
  });

  it("raises the owning bay's error as if the call had run here", async () => {
    resolveProjectBay.mockResolvedValue({ bay_id: "bay-1", epoch: 0 });
    forward.mockResolvedValue({
      ok: false,
      error: "only collaborators may do this",
      attrs: { code: 403 },
    });
    await expect(executeHubApiCall(routed())).rejects.toMatchObject({
      message: "only collaborators may do this",
      code: 403,
    });
  });
});

describe("handleForwardedHubApiCall on the owning bay", () => {
  const forwarded = (overrides = {}) => ({
    ...routed(),
    source_bay_id: "bay-1",
    ...overrides,
  });

  it("runs the call through the local pipeline without the transport field", async () => {
    resolveProjectBay.mockResolvedValue({ bay_id: "bay-0", epoch: 0 });
    expect(await handleForwardedHubApiCall(forwarded())).toEqual({
      ok: true,
      result: { ranHere: "projects.setProjectMetadata" },
    });
    expect(local).toHaveBeenCalledWith(routed());
  });

  it("runs a repeated call id once and returns the first outcome", async () => {
    resolveProjectBay.mockResolvedValue({ bay_id: "bay-0", epoch: 0 });
    const call = forwarded({ call_id: "11111111-1111-4111-8111-111111111111" });
    const first = await handleForwardedHubApiCall(call);
    const again = await handleForwardedHubApiCall(call);
    expect(again).toEqual(first);
    expect(local).toHaveBeenCalledTimes(1);
    // The call id is transport, not an argument of the method.
    expect(local).toHaveBeenCalledWith(routed());
    // A repeat must be the same call: its hash covers everything but the id.
    const { call_hash } = runForwardedCallOnce.mock.calls[0][0];
    expect(call_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(runForwardedCallOnce.mock.calls[1][0].call_hash).toBe(call_hash);
  });

  it("refuses methods that are not routable", async () => {
    const result = await handleForwardedHubApiCall(
      forwarded({ name: "projects.deleteProject" }),
    );
    expect(result).toMatchObject({ ok: false, attrs: { code: 403 } });
    expect(local).not.toHaveBeenCalled();
  });

  it("re-checks the method's principal policy", async () => {
    const result = await handleForwardedHubApiCall(
      forwarded({ account_id: undefined, host_id: "host" }),
    );
    expect(result).toMatchObject({ ok: false, attrs: { code: 403 } });
    expect(local).not.toHaveBeenCalled();
  });

  it("refuses agent principals", async () => {
    const result = await handleForwardedHubApiCall(
      forwarded({ auth_actor: "agent", project_id: PROJECT }),
    );
    expect(result).toMatchObject({ ok: false, attrs: { code: 403 } });
    expect(local).not.toHaveBeenCalled();
  });

  it("refuses banned accounts", async () => {
    isAccountBannedCached.mockReturnValue(true);
    const result = await handleForwardedHubApiCall(forwarded());
    expect(result).toMatchObject({ ok: false, error: "account is banned" });
    expect(local).not.toHaveBeenCalled();
  });

  it("never forwards a second time when ownership moved", async () => {
    resolveProjectBay.mockResolvedValue({ bay_id: "bay-2", epoch: 0 });
    const result = await handleForwardedHubApiCall(forwarded());
    expect(result).toMatchObject({ ok: false, attrs: { code: 409 } });
    expect(forward).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
  });

  it("returns the method's error with its attributes", async () => {
    resolveProjectBay.mockResolvedValue({ bay_id: "bay-0", epoch: 0 });
    local.mockRejectedValueOnce(
      Object.assign(new Error("not a collaborator"), { code: 403 }),
    );
    expect(await handleForwardedHubApiCall(forwarded())).toEqual({
      ok: false,
      error: "not a collaborator",
      attrs: { code: 403 },
    });
  });
});

describe("routing an email invite", () => {
  const INVITE = "77777777-7777-4777-8777-777777777777";
  const call = (args: any[]) => ({
    name: "projects.redeemEmailProjectInvite",
    args,
    account_id: ACCOUNT,
  });

  it("forwards to the bay the invite directory names, by id or token", async () => {
    resolveProjectCollabInviteDirectory.mockResolvedValue({
      invite_id: INVITE,
      owning_bay_id: "bay-1",
    });
    forward.mockResolvedValue({ ok: true, result: { redeemed: true } });
    expect(await executeHubApiCall(call([{ token: "tok" }]))).toEqual({
      redeemed: true,
    });
    expect(resolveProjectCollabInviteDirectory).toHaveBeenCalledWith({
      token_hash: "hash:tok",
    });
    expect(createInterBayHubApiClient).toHaveBeenCalledWith(
      expect.objectContaining({ bay_id: "bay-1" }),
    );
    expect(resolveProjectBay).not.toHaveBeenCalled();
  });

  it("runs here when the invite is unknown or owned here", async () => {
    resolveProjectCollabInviteDirectory.mockResolvedValueOnce(null);
    await executeHubApiCall(call([{ invite_id: INVITE, token: "tok" }]));
    resolveProjectCollabInviteDirectory.mockResolvedValueOnce({
      invite_id: INVITE,
      owning_bay_id: "bay-0",
    });
    await executeHubApiCall(call([{ invite_id: INVITE, token: "tok" }]));
    expect(local).toHaveBeenCalledTimes(2);
    expect(forward).not.toHaveBeenCalled();
  });
});

describe("a call on several projects", () => {
  const P = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ];
  const hide = (project_ids: unknown) => ({
    name: "projects.setProjectsHidden",
    args: [{ project_ids, hide: true }],
    account_id: ACCOUNT,
    auth_session_hash: "session",
  });
  // The method: one result per project it was given.
  const answer = (call) =>
    [].concat(call.args[0].project_ids).map((project_id) => ({
      project_id,
      success: true,
    }));

  beforeEach(() => {
    local.mockImplementation(async (call) => answer(call));
    forward.mockImplementation(async (call) => ({
      ok: true,
      result: answer(call),
    }));
  });

  it("runs here, unchanged, when this bay owns every project", async () => {
    resolveProjectBays.mockResolvedValue(
      new Map(P.map((id) => [id, { bay_id: "bay-0", epoch: 0 }])),
    );
    await executeHubApiCall(hide(P));
    expect(local).toHaveBeenCalledWith(hide(P));
    expect(forward).not.toHaveBeenCalled();
  });

  it("runs once per bay with that bay's projects, and merges in input order", async () => {
    resolveProjectBays.mockResolvedValue(
      new Map([
        [P[0], { bay_id: "bay-1", epoch: 0 }],
        [P[1], { bay_id: "bay-0", epoch: 0 }],
        [P[2], { bay_id: "bay-1", epoch: 0 }],
      ]),
    );
    const results = await executeHubApiCall(hide([P[0], P[1], P[2], P[0]]));
    expect(results.map((r) => r.project_id)).toEqual(P);
    expect(local).toHaveBeenCalledTimes(1);
    expect(local.mock.calls[0][0].args[0]).toEqual({
      project_ids: [P[1]],
      hide: true,
    });
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward.mock.calls[0][0]).toMatchObject({
      name: "projects.setProjectsHidden",
      account_id: ACCOUNT,
      auth_session_hash: "session",
      source_bay_id: "bay-0",
      args: [{ project_ids: [P[0], P[2]], hide: true }],
    });
  });

  it("keeps unknown projects and malformed ids here, where the method reports them", async () => {
    resolveProjectBays.mockResolvedValue(
      new Map([
        [P[0], { bay_id: "bay-1", epoch: 0 }],
        [P[1], null],
      ]),
    );
    await executeHubApiCall(hide([P[0], P[1], "nope"]));
    expect(resolveProjectBays).toHaveBeenCalledWith(
      [P[0], P[1]],
      expect.anything(),
    );
    expect(local.mock.calls[0][0].args[0].project_ids).toEqual([P[1], "nope"]);
    expect(forward.mock.calls[0][0].args[0].project_ids).toEqual([P[0]]);
  });

  it("gives each project of a bay that does not answer an error, and the rest their results", async () => {
    resolveProjectBays.mockResolvedValue(
      new Map([
        [P[0], { bay_id: "bay-1", epoch: 0 }],
        [P[1], { bay_id: "bay-0", epoch: 0 }],
      ]),
    );
    forward.mockRejectedValue(
      Object.assign(new Error("timeout"), { code: 408 }),
    );
    const results = await executeHubApiCall(hide([P[0], P[1]]));
    expect(results[0]).toEqual({
      project_id: P[0],
      success: false,
      error: expect.stringContaining("outcome unknown"),
    });
    expect(results[1]).toEqual({ project_id: P[1], success: true });
  });

  it("passes a malformed call through, for the method to reject", async () => {
    await executeHubApiCall(hide("not a list"));
    expect(resolveProjectBays).not.toHaveBeenCalled();
    expect(local).toHaveBeenCalledWith(hide("not a list"));
  });

  it("on the owning bay, leaves refusing foreign projects to the method", async () => {
    const result = await handleForwardedHubApiCall({
      ...hide([P[0]]),
      source_bay_id: "bay-1",
      call_id: "9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a",
    });
    expect(result).toEqual({
      ok: true,
      result: [{ project_id: P[0], success: true }],
    });
    expect(resolveProjectBays).not.toHaveBeenCalled();
  });

  it("refuses more than MAX_PROJECTS_PER_CALL projects before looking any up", async () => {
    const { MAX_PROJECTS_PER_CALL } =
      await import("@cocalc/conat/hub/api/routes");
    const many = Array.from(
      { length: MAX_PROJECTS_PER_CALL + 1 },
      (_, i) => `00000000-0000-4000-8000-${`${i}`.padStart(12, "0")}`,
    );
    await expect(executeHubApiCall(hide(many))).rejects.toThrow(
      `at most ${MAX_PROJECTS_PER_CALL}`,
    );
    expect(resolveProjectBays).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
  });

  it("handles a full-size list, nearly all on one bay", async () => {
    const { MAX_PROJECTS_PER_CALL } =
      await import("@cocalc/conat/hub/api/routes");
    const many = Array.from(
      { length: MAX_PROJECTS_PER_CALL },
      (_, i) => `00000000-0000-4000-8000-${`${i}`.padStart(12, "0")}`,
    );
    resolveProjectBays.mockResolvedValue(
      new Map(
        many.map((id, i) => [id, { bay_id: i === 0 ? "bay-1" : "bay-0" }]),
      ),
    );
    const t0 = Date.now();
    const results = await executeHubApiCall(hide(many));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(results.map((r) => r.project_id)).toEqual(many);
    expect(local.mock.calls[0][0].args[0].project_ids).toHaveLength(
      MAX_PROJECTS_PER_CALL - 1,
    );
  });

  it("trusts only exactly one result per project from each bay", async () => {
    resolveProjectBays.mockResolvedValue(
      new Map([
        [P[0], { bay_id: "bay-1", epoch: 0 }],
        [P[1], { bay_id: "bay-1", epoch: 0 }],
        [P[2], { bay_id: "bay-0", epoch: 0 }],
      ]),
    );
    forward.mockResolvedValue({
      ok: true,
      result: [
        // P[0] missing; P[1] twice; a project bay-1 was not asked about.
        { project_id: P[1], success: true },
        { project_id: P[1], success: true },
        { project_id: "44444444-4444-4444-8444-444444444444", success: true },
      ],
    });
    expect(await executeHubApiCall(hide(P))).toEqual([
      {
        project_id: P[0],
        success: false,
        error: "bay-1 returned 0 results for this project",
      },
      {
        project_id: P[1],
        success: false,
        error: "bay-1 returned 2 results for this project",
      },
      { project_id: P[2], success: true },
    ]);
  });

  it("treats a valid upper-case id as the project it names", async () => {
    resolveProjectBays.mockResolvedValue(
      new Map([
        [P[0], { bay_id: "bay-1", epoch: 0 }],
        [P[1], null],
      ]),
    );
    const results = await executeHubApiCall(hide([P[0].toUpperCase(), P[1]]));
    expect(resolveProjectBays).toHaveBeenCalledWith(
      [P[0], P[1]],
      expect.anything(),
    );
    expect(forward.mock.calls[0][0].args[0].project_ids).toEqual([P[0]]);
    expect(results.map((r) => r.project_id)).toEqual([P[0], P[1]]);
  });

  it("checks the results of an all-local call as well", async () => {
    resolveProjectBays.mockResolvedValue(
      new Map(P.map((id) => [id, { bay_id: "bay-0", epoch: 0 }])),
    );
    local.mockResolvedValue([
      { project_id: P[1], success: true },
      { project_id: P[1], success: true },
      { project_id: P[2], success: true },
      { project_id: "44444444-4444-4444-8444-444444444444", success: true },
    ]);
    expect(await executeHubApiCall(hide(P))).toEqual([
      {
        project_id: P[0],
        success: false,
        error: "bay-0 returned 0 results for this project",
      },
      {
        project_id: P[1],
        success: false,
        error: "bay-0 returned 2 results for this project",
      },
      { project_id: P[2], success: true },
    ]);
    expect(local).toHaveBeenCalledWith(hide(P));
  });

  it("raises the error of an all-local call, as before", async () => {
    resolveProjectBays.mockResolvedValue(
      new Map([[P[0], { bay_id: "bay-0", epoch: 0 }]]),
    );
    local.mockRejectedValue(new Error("hide must be a boolean"));
    await expect(executeHubApiCall(hide([P[0]]))).rejects.toThrow(
      "hide must be a boolean",
    );
  });

  it("runs on at most three bays at a time", async () => {
    const ids = Array.from(
      { length: 7 },
      (_, i) => `00000000-0000-4000-8000-00000000000${i}`,
    );
    resolveProjectBays.mockResolvedValue(
      new Map(ids.map((id, i) => [id, { bay_id: `bay-${i}`, epoch: 0 }])),
    );
    let running = 0;
    let most = 0;
    const slow = async (result) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return result;
    };
    local.mockImplementation(async (call) => await slow(answer(call)));
    forward.mockImplementation(
      async (call) => await slow({ ok: true, result: answer(call) }),
    );
    const results = await executeHubApiCall(hide(ids));
    expect(results.map((r) => r.project_id)).toEqual(ids);
    expect(forward).toHaveBeenCalledTimes(6);
    expect(most).toBe(3);
  });

  it("answers within the caller's time: parts that cannot finish in it never start", async () => {
    const ids = Array.from(
      { length: 7 },
      (_, i) => `00000000-0000-4000-8000-00000000000${i}`,
    );
    resolveProjectBays.mockResolvedValue(
      new Map(ids.map((id, i) => [id, { bay_id: `bay-${i + 1}`, epoch: 0 }])),
    );
    // A clock where each unanswered attempt takes its full 12 s; concurrent
    // attempts overlap in time.
    let now = 1_000_000;
    const clock = jest.spyOn(Date, "now").mockImplementation(() => now);
    forward.mockImplementation(async () => {
      const started = now;
      await Promise.resolve();
      now = Math.max(now, started + 12_000);
      throw Object.assign(new Error("timeout"), { code: 408 });
    });
    try {
      const results = await executeHubApiCall(hide(ids));
      expect(results.map((r) => r.project_id)).toEqual(ids);
      // Three bays at once, two attempts each; the first wave used the time.
      expect(forward).toHaveBeenCalledTimes(6);
      expect(now - 1_000_000).toBeLessThanOrEqual(28_000);
      for (const r of results.slice(0, 3)) {
        expect(r.error).toContain("outcome unknown");
      }
      for (const r of results.slice(3)) {
        expect(r.error).toContain("not attempted");
        expect(r.error).toContain("safe to retry");
      }
    } finally {
      clock.mockRestore();
    }
  });

  it("runs this bay's own part first", async () => {
    resolveProjectBays.mockResolvedValue(
      new Map([
        [P[0], { bay_id: "bay-1", epoch: 0 }],
        [P[1], { bay_id: "bay-2", epoch: 0 }],
        [P[2], { bay_id: "bay-0", epoch: 0 }],
      ]),
    );
    const order: string[] = [];
    local.mockImplementation(async (call) => {
      order.push("bay-0");
      return answer(call);
    });
    forward.mockImplementation(async (call) => {
      order.push(call.args[0].project_ids[0]);
      return { ok: true, result: answer(call) };
    });
    await executeHubApiCall(hide(P));
    expect(order[0]).toBe("bay-0");
  });

  it("looks up owning bays within the call's budget, and does not run a project whose bay was not found in time", async () => {
    const t0 = Date.now();
    // P[1]'s bay is not resolved in time: left out of the lookup's result.
    resolveProjectBays.mockResolvedValue(
      new Map([
        [P[0], { bay_id: "bay-1", epoch: 0 }],
        [P[2], { bay_id: "bay-0", epoch: 0 }],
      ]),
    );
    const results = await executeHubApiCall(hide(P));
    const { deadline } = resolveProjectBays.mock.calls[0][1];
    // Room is left for a full forwarded part (24 s) within the 28 s budget.
    expect(deadline).toBeGreaterThanOrEqual(t0 + 4_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 4_000);
    expect(results.map((r) => r.project_id)).toEqual(P);
    expect(results[1]).toEqual({
      project_id: P[1],
      success: false,
      error: expect.stringContaining("could not be found in time"),
    });
    expect(results[0]).toEqual({ project_id: P[0], success: true });
    expect(results[2]).toEqual({ project_id: P[2], success: true });
    expect(local.mock.calls[0][0].args[0].project_ids).toEqual([P[2]]);
    expect(forward.mock.calls[0][0].args[0].project_ids).toEqual([P[0]]);
  });

  it("does not run an all-local call unchanged when a project's bay is unresolved", async () => {
    resolveProjectBays.mockResolvedValue(
      new Map([[P[0], { bay_id: "bay-0", epoch: 0 }]]),
    );
    const results = await executeHubApiCall(hide([P[0], P[1]]));
    expect(local.mock.calls[0][0].args[0].project_ids).toEqual([P[0]]);
    expect(results[1].error).toContain("not attempted");
  });

  const leave = (project_ids: string[]) => ({
    name: "projects.leaveOrDeleteProjects",
    args: [{ project_ids, browser_id: "b" }],
    account_id: ACCOUNT,
    auth_session_hash: "session",
  });

  it("refuses more than one project on a bay for leave/delete, before any part runs", async () => {
    resolveProjectBays.mockResolvedValue(
      new Map([
        [P[0], { bay_id: "bay-1", epoch: 0 }],
        [P[1], { bay_id: "bay-1", epoch: 0 }],
        [P[2], { bay_id: "bay-0", epoch: 0 }],
      ]),
    );
    await expect(executeHubApiCall(leave(P))).rejects.toThrow(
      "at most 1 project(s) on one bay",
    );
    expect(local).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("returns a single remote bay's error per project, with its code", async () => {
    resolveProjectBays.mockResolvedValue(
      new Map([[P[0], { bay_id: "bay-1", epoch: 0 }]]),
    );
    forward.mockResolvedValue({
      ok: false,
      error: "fresh auth is required",
      attrs: { code: "fresh_auth_required" },
    });
    expect(await executeHubApiCall(leave([P[0]]))).toEqual([
      {
        project_id: P[0],
        action: "error",
        error: "fresh auth is required",
        code: "fresh_auth_required",
      },
    ]);
  });

  it("returns an array for projects all on one remote bay that does not answer", async () => {
    resolveProjectBays.mockResolvedValue(
      new Map([
        [P[0], { bay_id: "bay-1", epoch: 0 }],
        [P[1], { bay_id: "bay-1", epoch: 0 }],
      ]),
    );
    forward.mockRejectedValue(
      Object.assign(new Error("timeout"), { code: 408 }),
    );
    const results = await executeHubApiCall(hide([P[0], P[1]]));
    expect(results.map((r) => [r.project_id, r.success])).toEqual([
      [P[0], false],
      [P[1], false],
    ]);
    expect(results[0].error).toContain("outcome unknown");
  });

  it("keeps the code of a bay's failure on its projects' results", async () => {
    resolveProjectBays.mockResolvedValue(
      new Map([
        [P[0], { bay_id: "bay-1", epoch: 0 }],
        [P[1], { bay_id: "bay-0", epoch: 0 }],
      ]),
    );
    local.mockImplementation(async (call) =>
      call.args[0].project_ids.map((project_id) => ({
        project_id,
        action: "removed_self",
      })),
    );
    forward.mockRejectedValue(
      Object.assign(new Error("timeout"), { code: 408 }),
    );
    expect(await executeHubApiCall(leave([P[0], P[1]]))).toEqual([
      {
        project_id: P[0],
        action: "error",
        error: expect.stringContaining("outcome unknown"),
        code: "OUTCOME_UNKNOWN",
      },
      { project_id: P[1], action: "removed_self" },
    ]);
  });
});
