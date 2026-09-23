import { randomUUID } from "node:crypto";
import { viewerReadPolicyAllowsPath } from "@cocalc/util/project-access";

const mockStore = {
  get: jest.fn(),
  activeRun: jest.fn(),
  query: jest.fn(),
  transaction: jest.fn(),
};
const mockAssertActor = jest.fn();
const mockAssertAgent = jest.fn();
const mockAssertRun = jest.fn();
const mockAssertProjectAccess = jest.fn();

jest.mock("./store", () => ({ agentStore: () => mockStore }));
jest.mock("./access", () => ({
  assertActor: (...args: any[]) => mockAssertActor(...args),
  assertAgent: (...args: any[]) => mockAssertAgent(...args),
  assertRun: (...args: any[]) => mockAssertRun(...args),
}));
jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  assertProjectCollaboratorAccessAllowRemote: (...args: any[]) =>
    mockAssertProjectAccess(...args),
}));
jest.mock("./identity-routing", () => ({
  withAgentIdentityOwner: jest.fn(),
}));
jest.mock("@cocalc/server/conat/api/hosts", () => ({
  resolveHostConnection: jest.fn(),
  issueProjectHostFileGrantToken: jest.fn(),
}));

import { authorizeFileGrantReadLocal, saveFileGrantLocal } from "./file-grants";

describe("agent file grants", () => {
  const account_id = randomUUID();
  const source_project_id = randomUUID();
  const target_project_id = randomUUID();
  const agent_id = randomUUID();
  const host_id = randomUUID();
  const run_id = randomUUID();

  beforeEach(() => {
    jest.clearAllMocks();
    mockStore.get.mockResolvedValue({
      agent_id,
      project_id: source_project_id,
    });
    mockAssertProjectAccess.mockResolvedValue({ host_id });
  });

  test("updating a grant rotates its id and invalidates old credentials", async () => {
    const issued: string[] = [];
    mockStore.transaction.mockImplementation(async (fn) =>
      fn({
        query: jest.fn(async (sql: string, params: any[]) => {
          if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
          if (sql.includes("SELECT 1 FROM agent_file_grants")) {
            return { rows: [{ exists: 1 }] };
          }
          if (sql.includes("INSERT INTO agent_file_grants")) {
            issued.push(params[0]);
            return {
              rows: [
                {
                  grant_id: params[0],
                  account_id,
                  agent_id,
                  source_project_id,
                  target_project_id,
                  roots: JSON.parse(params[5]),
                  mode: params[6],
                },
              ],
            };
          }
          throw new Error(`unexpected query: ${sql}`);
        }),
      }),
    );

    const first = await saveFileGrantLocal({
      account_id,
      project_id: source_project_id,
      agent_id,
      target_project_id,
      roots: ["docs"],
    });
    const second = await saveFileGrantLocal({
      account_id,
      project_id: source_project_id,
      agent_id,
      target_project_id,
      roots: ["src"],
      mode: "read-write",
    });

    expect(first.grant_id).not.toBe(second.grant_id);
    expect(first.mode).toBe("read");
    expect(second.mode).toBe("read-write");
    expect(issued).toEqual([first.grant_id, second.grant_id]);
  });

  test("authorizes only the exact active run, host, and unrevoked grant", async () => {
    const grant_id = randomUUID();
    mockStore.activeRun.mockResolvedValue({
      account_id,
      project_id: source_project_id,
      issued_at: new Date(),
    });
    mockStore.query.mockResolvedValue({
      rows: [{ roots: ["docs/*", "README.md"] }],
    });

    await expect(
      authorizeFileGrantReadLocal({
        account_id,
        host_id,
        source_project_id,
        target_project_id,
        grant_id,
        agent_id,
        run_id,
      }),
    ).resolves.toEqual({
      mode: "read",
      read_policy: {
        rules: [
          { action: "include", path: "docs/*", match: "prefix" },
          { action: "include", path: "README.md", match: "prefix" },
          { action: "exclude", path: ".snapshots", match: "prefix" },
          { action: "exclude", path: ".ssh", match: "prefix" },
          {
            action: "exclude",
            path: ".local/share/cocalc",
            match: "prefix",
          },
        ],
      },
    });
    expect(mockAssertRun).toHaveBeenCalledTimes(1);
    mockStore.query.mockResolvedValueOnce({
      rows: [{ roots: ["docs"], mode: "read-write" }],
    });
    await expect(
      authorizeFileGrantReadLocal({
        account_id,
        host_id,
        source_project_id,
        target_project_id,
        grant_id,
        agent_id,
        run_id,
      }),
    ).resolves.toMatchObject({ mode: "read-write" });
    mockStore.query.mockResolvedValueOnce({
      rows: [{ roots: ["docs"], mode: "admin" }],
    });
    await expect(
      authorizeFileGrantReadLocal({
        account_id,
        host_id,
        source_project_id,
        target_project_id,
        grant_id,
        agent_id,
        run_id,
      }),
    ).rejects.toThrow("invalid file grant mode");

    mockAssertProjectAccess.mockResolvedValueOnce({ host_id: randomUUID() });
    await expect(
      authorizeFileGrantReadLocal({
        account_id,
        host_id,
        source_project_id,
        target_project_id,
        grant_id,
        agent_id,
        run_id,
      }),
    ).rejects.toThrow("target host changed");

    mockStore.query.mockResolvedValueOnce({ rows: [] });
    await expect(
      authorizeFileGrantReadLocal({
        account_id,
        host_id,
        source_project_id,
        target_project_id,
        grant_id,
        agent_id,
        run_id,
      }),
    ).rejects.toThrow("unavailable or revoked");
  });

  test("whole-home grants retain mandatory sensitive namespace exclusions", async () => {
    mockStore.activeRun.mockResolvedValue({
      account_id,
      project_id: source_project_id,
      issued_at: new Date(),
    });
    mockStore.query.mockResolvedValue({ rows: [{ roots: [""] }] });

    const { read_policy } = await authorizeFileGrantReadLocal({
      account_id,
      host_id,
      source_project_id,
      target_project_id,
      grant_id: randomUUID(),
      agent_id,
      run_id,
    });

    expect(
      viewerReadPolicyAllowsPath({ policy: read_policy, path: "README.md" }),
    ).toBe(true);
    for (const path of [
      ".snapshots/old/secret",
      ".ssh/id_ed25519",
      ".local/share/cocalc/runtime/token",
    ]) {
      expect(viewerReadPolicyAllowsPath({ policy: read_policy, path })).toBe(
        false,
      );
    }
  });

  test("rejects a run bound to another account or source project", async () => {
    mockStore.activeRun.mockResolvedValue({
      account_id: randomUUID(),
      project_id: source_project_id,
      issued_at: new Date(),
    });
    await expect(
      authorizeFileGrantReadLocal({
        account_id,
        host_id,
        source_project_id,
        target_project_id,
        grant_id: randomUUID(),
        agent_id,
        run_id,
      }),
    ).rejects.toThrow("run binding mismatch");
    expect(mockStore.query).not.toHaveBeenCalled();
  });
});
