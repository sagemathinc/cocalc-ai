/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export {};

const APPROVER = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT = "44444444-4444-4444-8444-444444444444";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const HEAD = "c".repeat(40);
const FINGERPRINT = "f".repeat(64);

let bayId = "seed";
let settings: any;
const snapshotMock = jest.fn();
const headMock = jest.fn();
const createMock = jest.fn();
const getMock = jest.fn();
const decideMock = jest.fn();
const dangerousAuthMock = jest.fn();
const impersonationMock = jest.fn();
const accountMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({}),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => bayId,
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterSeedBayId: () => "seed",
}));
jest.mock("./settings", () => ({
  getMergeApprovalSettings: async () => settings,
}));
jest.mock("./github", () => ({
  readPullRequestSnapshot: (...args: any[]) => snapshotMock(...args),
  readPullRequestHead: (...args: any[]) => headMock(...args),
}));
jest.mock("./store", () => ({
  MergeApprovalStore: jest.fn().mockImplementation(() => ({
    create: (...args: any[]) => createMock(...args),
    get: (...args: any[]) => getMock(...args),
    decide: (...args: any[]) => decideMock(...args),
  })),
}));
jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: (...args: any[]) => dangerousAuthMock(...args),
}));
jest.mock("@cocalc/server/auth/impersonation", () => ({
  getImpersonationSessionBySessionHash: (...args: any[]) =>
    impersonationMock(...args),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: (...args: any[]) => accountMock(...args),
}));

import { decideMergeApproval, requestMergeApproval } from "./api";

const app = {
  app_id: "1",
  private_key: "key",
  installations: new Map([["o", "2"]]),
};

function prSnapshot(overrides = {}) {
  return {
    title: "t",
    state: "open",
    draft: false,
    author: "a",
    base_ref: "main",
    head_ref: "b",
    head_sha: HEAD,
    html_url: "u",
    additions: 0,
    deletions: 0,
    changed_files: 0,
    files: [],
    files_truncated: false,
    checks: [],
    reviews: [],
    read_at: "now",
    ...overrides,
  };
}

const agentRequest = (overrides = {}) => ({
  account_id: APPROVER,
  project_id: PROJECT,
  auth_actor: "agent" as const,
  auth_token_fingerprint: FINGERPRINT,
  repo: "O/R",
  pr_number: 7,
  head_sha: HEAD,
  note: "please review",
  agent_label: "ops3",
  chat: { path: "a.chat", thread_id: "t" },
  ...overrides,
});

const decision = (overrides = {}) => ({
  account_id: APPROVER,
  session_hash: "session-hash",
  request_id: REQUEST_ID,
  decision: "approve" as const,
  comment: "ok",
  ...overrides,
});

beforeEach(() => {
  bayId = "seed";
  settings = {
    approvers: [APPROVER],
    repos: ["o/r", "o/relaxed"],
    second_factor_repos: "o/r",
    app,
  };
  snapshotMock.mockReset().mockResolvedValue(prSnapshot());
  headMock.mockReset().mockResolvedValue({
    head_sha: HEAD,
    base_sha: "b".repeat(40),
    state: "open",
    draft: false,
  });
  // Like the store: verify runs under the PR lock, before any write.
  createMock.mockReset().mockImplementation(async (req, { verify }) => {
    await verify?.();
    return { id: REQUEST_ID, status: "pending", ...req };
  });
  getMock.mockReset().mockResolvedValue({
    id: REQUEST_ID,
    repo: "o/r",
    status: "pending",
  });
  decideMock.mockReset().mockResolvedValue({ request: {}, decision: {} });
  dangerousAuthMock.mockReset().mockResolvedValue({
    session_hash: "session-hash",
    factor_level: "totp",
  });
  impersonationMock.mockReset().mockResolvedValue(undefined);
  accountMock.mockReset().mockResolvedValue({
    account_id: APPROVER,
    home_bay_id: "seed",
  });
});

describe("requestMergeApproval", () => {
  it("records what GitHub says, with the requester from the session", async () => {
    await requestMergeApproval(agentRequest());
    expect(snapshotMock).toHaveBeenCalledWith({
      config: app,
      repo: "o/r",
      pr_number: 7,
    });
    expect(headMock).toHaveBeenCalledWith({
      config: app,
      repo: "o/r",
      pr_number: 7,
    });
    expect(createMock.mock.calls[0][0]).toEqual({
      repo: "o/r",
      pr_number: 7,
      head_sha: HEAD,
      base_ref: "main",
      github_snapshot: prSnapshot(),
      agent_note: "please review",
      requested_by: {
        account_id: APPROVER,
        project_id: PROJECT,
        token_fingerprint: FINGERPRINT,
        agent_label: "ops3",
      },
      chat: {
        project_id: PROJECT,
        path: "a.chat",
        thread_id: "t",
        message_date: undefined,
      },
    });
  });

  it("checks the head again under the PR lock, and writes nothing if it moved", async () => {
    headMock.mockResolvedValue({
      head_sha: "d".repeat(40),
      base_sha: "b".repeat(40),
      state: "open",
      draft: false,
    });
    await expect(requestMergeApproval(agentRequest())).rejects.toMatchObject({
      code: "head_mismatch",
    });
    headMock.mockResolvedValue({
      head_sha: HEAD,
      base_sha: "b".repeat(40),
      state: "closed",
      draft: false,
    });
    await expect(requestMergeApproval(agentRequest())).rejects.toThrow(
      "changed; try again",
    );
  });

  it("refuses anything but an agent session", async () => {
    for (const opts of [
      agentRequest({ auth_actor: undefined }),
      agentRequest({ project_id: undefined }),
      agentRequest({ account_id: undefined }),
    ]) {
      await expect(requestMergeApproval(opts)).rejects.toThrow(
        "requested by an agent session",
      );
    }
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it("fails closed off the seed bay", async () => {
    bayId = "other";
    await expect(requestMergeApproval(agentRequest())).rejects.toThrow(
      "only available on the seed bay",
    );
  });

  it("refuses when disabled, for non-approvers' agents and for other repos", async () => {
    settings.approvers = [];
    await expect(requestMergeApproval(agentRequest())).rejects.toThrow(
      "not enabled",
    );
    settings.approvers = [APPROVER];
    await expect(
      requestMergeApproval(agentRequest({ account_id: OTHER_ACCOUNT })),
    ).rejects.toThrow("can't request merge approvals");
    await expect(
      requestMergeApproval(agentRequest({ repo: "o/elsewhere" })),
    ).rejects.toThrow("not enabled for o/elsewhere");
    settings.app = undefined;
    await expect(requestMergeApproval(agentRequest())).rejects.toThrow(
      "App is not configured",
    );
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it("limits the note and keeps the chat in the requesting project", async () => {
    await expect(
      requestMergeApproval(agentRequest({ note: "x".repeat(8 * 1024 + 1) })),
    ).rejects.toThrow("note is longer");
    await expect(
      requestMergeApproval(
        agentRequest({
          chat: { path: "a.chat", project_id: OTHER_ACCOUNT } as any,
        }),
      ),
    ).rejects.toThrow("requesting project");
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it("refuses a head that is not the PR's current head", async () => {
    snapshotMock.mockResolvedValue(prSnapshot({ head_sha: "d".repeat(40) }));
    await expect(requestMergeApproval(agentRequest())).rejects.toMatchObject({
      code: "head_mismatch",
      current_head_sha: "d".repeat(40),
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("refuses closed, merged and draft PRs", async () => {
    for (const overrides of [
      { state: "closed" },
      { state: "merged" },
      { draft: true },
    ]) {
      snapshotMock.mockResolvedValue(prSnapshot(overrides));
      await expect(requestMergeApproval(agentRequest())).rejects.toThrow(
        /is (closed|merged|a draft)/,
      );
    }
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("decideMergeApproval", () => {
  it("records an approver's decision with the session's factor", async () => {
    await decideMergeApproval(decision());
    expect(dangerousAuthMock).toHaveBeenCalledWith({
      account_id: APPROVER,
      session_hash: "session-hash",
      require_second_factor: true,
      allow_actor_impersonation: false,
    });
    expect(decideMock).toHaveBeenCalledWith({
      request_id: REQUEST_ID,
      account_id: APPROVER,
      decision: "approve",
      comment: "ok",
      session_hash: "session-hash",
      factor_level: "totp",
    });
  });

  it("refuses agents, callers without a session, and non-approvers", async () => {
    await expect(
      decideMergeApproval({ ...decision(), auth_actor: "agent" } as any),
    ).rejects.toThrow("browser session");
    await expect(
      decideMergeApproval(decision({ account_id: undefined })),
    ).rejects.toThrow("browser session");
    await expect(
      decideMergeApproval(decision({ session_hash: undefined })),
    ).rejects.toMatchObject({ code: "fresh_auth_required" });
    await expect(
      decideMergeApproval(decision({ account_id: OTHER_ACCOUNT })),
    ).rejects.toThrow("only merge approvers");
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("fails closed off the seed bay, or when the approver's home is elsewhere", async () => {
    bayId = "other";
    await expect(decideMergeApproval(decision())).rejects.toThrow(
      "only available on the seed bay",
    );
    bayId = "seed";
    accountMock.mockResolvedValue({ account_id: APPROVER, home_bay_id: "b2" });
    await expect(decideMergeApproval(decision())).rejects.toThrow(
      "home on the seed bay",
    );
    expect(dangerousAuthMock).not.toHaveBeenCalled();
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("refuses an impersonated session, whatever the repo", async () => {
    getMock.mockResolvedValue({ id: REQUEST_ID, repo: "o/relaxed" });
    impersonationMock.mockResolvedValue({ actor_account_id: OTHER_ACCOUNT });
    await expect(decideMergeApproval(decision())).rejects.toMatchObject({
      code: "impersonation_blocked",
    });
    expect(impersonationMock).toHaveBeenCalledWith({
      session_hash: "session-hash",
      subject_account_id: APPROVER,
    });
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("requires a second factor to approve only where the repo needs one", async () => {
    getMock.mockResolvedValue({ id: REQUEST_ID, repo: "o/relaxed" });
    await decideMergeApproval(decision());
    expect(dangerousAuthMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ require_second_factor: false }),
    );
    getMock.mockResolvedValue({ id: REQUEST_ID, repo: "o/r" });
    await decideMergeApproval(decision({ decision: "reject" }));
    expect(dangerousAuthMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ require_second_factor: false }),
    );
    await decideMergeApproval(decision());
    expect(dangerousAuthMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ require_second_factor: true }),
    );
  });

  it("does not record anything when fresh auth fails", async () => {
    dangerousAuthMock.mockRejectedValue(
      Object.assign(new Error("recent two-factor verification is required"), {
        code: "fresh_auth_required",
      }),
    );
    await expect(decideMergeApproval(decision())).rejects.toThrow(
      "recent two-factor",
    );
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("validates the decision and the comment", async () => {
    await expect(
      decideMergeApproval(decision({ decision: "merge" as any })),
    ).rejects.toThrow("approve or reject");
    await expect(
      decideMergeApproval(decision({ request_id: "nope" })),
    ).rejects.toThrow("invalid merge approval request id");
    await expect(
      decideMergeApproval(decision({ comment: "x".repeat(2049) })),
    ).rejects.toThrow("comment is longer");
    getMock.mockResolvedValue(undefined);
    await expect(decideMergeApproval(decision())).rejects.toThrow("not found");
  });
});
