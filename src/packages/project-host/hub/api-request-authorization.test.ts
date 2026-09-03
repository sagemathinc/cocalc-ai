/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockGetRow = jest.fn();

jest.mock("@cocalc/lite/hub/sqlite/database", () => ({
  getRow: (...args: any[]) => mockGetRow(...args),
}));

import {
  ACCOUNT_PROJECT_HOST_HUB_METHODS,
  authorizeProjectHostHubApiRequest,
  EXAM_PROJECT_HOST_HUB_METHODS,
  PROJECT_PROJECT_HOST_HUB_METHODS,
} from "./api-request-authorization";

const account_id = "00000000-1000-4000-8000-000000000001";
const project_id = "00000000-1000-4000-8000-000000000002";
const other_project_id = "00000000-1000-4000-8000-000000000003";
const host_id = "00000000-1000-4000-8000-000000000004";

function accountRequest(name: string, target = project_id) {
  return {
    subject: `hub.account.${account_id}.api`,
    name,
    args: [{ project_id: target, account_id }],
    account_id,
  };
}

function projectRequest(name: string, target = project_id) {
  return {
    subject: `hub.project.${project_id}.api`,
    name,
    args: [{ project_id: target }],
    project_id,
  };
}

function sourceProjectRequest({
  name,
  target = project_id,
  principal = "account",
}: {
  name: string;
  target?: string;
  principal?: "account" | "project";
}) {
  return {
    subject:
      principal === "account"
        ? `hub.account.${account_id}.api`
        : `hub.project.${project_id}.api`,
    name,
    args: [{ source_project_id: target, account_id }],
    ...(principal === "account" ? { account_id } : { project_id }),
  };
}

function expectForbidden(run: () => void): void {
  let error: unknown;
  try {
    run();
  } catch (err) {
    error = err;
  }
  expect(error).toMatchObject({ code: 403 });
}

describe("project-host hub API request authorization", () => {
  beforeEach(() => {
    mockGetRow.mockReset();
    mockGetRow.mockReturnValue({
      users: { [account_id]: { group: "collaborator" } },
    });
  });

  it("allows account and project health probes", () => {
    expect(() =>
      authorizeProjectHostHubApiRequest({
        ...accountRequest("system.ping"),
        args: [],
      }),
    ).not.toThrow();
    expect(() =>
      authorizeProjectHostHubApiRequest({
        ...projectRequest("system.ping"),
        args: [],
      }),
    ).not.toThrow();
    expect(mockGetRow).not.toHaveBeenCalled();
  });

  it("allows only the routed account methods for local collaborators", () => {
    for (const name of ACCOUNT_PROJECT_HOST_HUB_METHODS) {
      expect(() =>
        authorizeProjectHostHubApiRequest(accountRequest(name)),
      ).not.toThrow();
    }
    expect(mockGetRow).toHaveBeenCalledWith(
      "projects",
      JSON.stringify({ project_id }),
    );
  });

  it("authorizes account notification proxies by source project", () => {
    for (const name of [
      "notifications.createCodexAttentionNotice",
      "notifications.getCodexFreshAuthActionStatus",
    ]) {
      expect(() =>
        authorizeProjectHostHubApiRequest(
          sourceProjectRequest({ name, principal: "account" }),
        ),
      ).not.toThrow();
      mockGetRow.mockImplementation((_table, key) =>
        key === JSON.stringify({ project_id })
          ? { users: { [account_id]: { group: "collaborator" } } }
          : undefined,
      );
      expectForbidden(() =>
        authorizeProjectHostHubApiRequest(
          sourceProjectRequest({
            name,
            principal: "account",
            target: other_project_id,
          }),
        ),
      );
    }
  });

  it("denies embedded hub API methods to exam accounts", () => {
    mockGetRow.mockImplementation((table) =>
      table === "accounts"
        ? { exam_mode: true, exam_project_id: project_id }
        : { users: { [account_id]: { group: "owner" } } },
    );
    expectForbidden(() =>
      authorizeProjectHostHubApiRequest(
        accountRequest("projects.codexDeviceAuthStart"),
      ),
    );
    expect(() =>
      authorizeProjectHostHubApiRequest({
        ...accountRequest("system.ping"),
        args: [],
      }),
    ).not.toThrow();
  });

  it.each(["owner", "collaborator"])("accepts the %s project role", (group) => {
    mockGetRow.mockReturnValue({ users: { [account_id]: group } });
    expect(() =>
      authorizeProjectHostHubApiRequest(
        accountRequest("projects.chatStoreStats"),
      ),
    ).not.toThrow();
  });

  it.each(["viewer", "public", "admin", undefined])(
    "rejects the %s project role",
    (group) => {
      mockGetRow.mockReturnValue(
        group == null ? undefined : { users: { [account_id]: { group } } },
      );
      expectForbidden(() =>
        authorizeProjectHostHubApiRequest(
          accountRequest("projects.chatStoreStats"),
        ),
      );
    },
  );

  it("rejects an account request without a valid target project", () => {
    expectForbidden(() =>
      authorizeProjectHostHubApiRequest({
        ...accountRequest("projects.chatStoreStats"),
        args: [{}],
      }),
    );
    expect(mockGetRow).not.toHaveBeenCalled();
  });

  it.each([
    "projects.start",
    "projects.stop",
    "projects.createBackup",
    "projects.restoreBackup",
    "db.userQuery",
    "agent.execute",
    "sync.history",
    "unknown.method",
  ])("rejects account access to %s", (name) => {
    expectForbidden(() =>
      authorizeProjectHostHubApiRequest(accountRequest(name)),
    );
    expect(mockGetRow).not.toHaveBeenCalled();
  });

  it("allows the narrow project-identity method set bound to itself", () => {
    for (const name of PROJECT_PROJECT_HOST_HUB_METHODS) {
      expect(() =>
        authorizeProjectHostHubApiRequest(projectRequest(name)),
      ).not.toThrow();
    }
    expect(mockGetRow).toHaveBeenCalledWith(
      "projects",
      JSON.stringify({ project_id }),
    );
  });

  it("authorizes Codex completion notices by source project", () => {
    expect(() =>
      authorizeProjectHostHubApiRequest(
        sourceProjectRequest({
          name: "notifications.createCodexTurnNotice",
          principal: "project",
        }),
      ),
    ).not.toThrow();
    expectForbidden(() =>
      authorizeProjectHostHubApiRequest(
        sourceProjectRequest({
          name: "notifications.createCodexTurnNotice",
          principal: "project",
          target: other_project_id,
        }),
      ),
    );
  });

  it("restricts exam project identities to non-publication methods", () => {
    mockGetRow.mockImplementation((table) =>
      table === "projects"
        ? { local_only: true, exam_run_id: host_id }
        : undefined,
    );
    for (const name of EXAM_PROJECT_HOST_HUB_METHODS) {
      expect(() =>
        authorizeProjectHostHubApiRequest(projectRequest(name)),
      ).not.toThrow();
    }
    for (const name of [
      "compute.authorizeProjectSshKey",
      "system.reserveProjectAppPrivateHostname",
    ]) {
      expectForbidden(() =>
        authorizeProjectHostHubApiRequest(projectRequest(name)),
      );
    }
  });

  it("rejects a project identity targeting another project", () => {
    expectForbidden(() =>
      authorizeProjectHostHubApiRequest(
        projectRequest(
          "system.getProjectAppPrivateHostnamePolicy",
          other_project_id,
        ),
      ),
    );
  });

  it.each([
    "projects.start",
    "projects.createBackup",
    "projects.restoreSnapshot",
    "db.userQuery",
    "agent.execute",
    "sync.purgeHistory",
    "unknown.method",
  ])("rejects project access to %s", (name) => {
    expectForbidden(() =>
      authorizeProjectHostHubApiRequest(projectRequest(name)),
    );
  });

  it("retains the trusted host-scoped internal surface", () => {
    expect(() =>
      authorizeProjectHostHubApiRequest({
        subject: `hub.host.${host_id}.api`,
        name: "projects.createBackup",
        args: [{ project_id }],
        host_id,
      }),
    ).not.toThrow();
  });

  it("rejects a request without a recognized identity", () => {
    expectForbidden(() =>
      authorizeProjectHostHubApiRequest({
        subject: "hub.invalid.invalid.api",
        name: "system.ping",
        args: [],
      }),
    );
  });
});
