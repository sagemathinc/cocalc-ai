/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { generateKeyPairSync } from "node:crypto";
import { verifyProjectContentCapability } from "@cocalc/conat/auth/project-content-capability";

const queryMock = jest.fn();
const settingsMock = jest.fn();
const bannedMock = jest.fn();
const resolveProjectBayMock = jest.fn();

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }) as string;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: queryMock }),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: () => settingsMock(),
}));
jest.mock("@cocalc/server/accounts/security-state", () => ({
  ensureAccountSecurityStateReady: async () => {},
  isAccountBannedCached: (account_id: string) => bannedMock(account_id),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (project_id: string) => resolveProjectBayMock(project_id),
}));
jest.mock("@cocalc/backend/data", () => ({
  getProjectHostAuthTokenPrivateKey: () => PRIVATE_KEY,
}));

import {
  encodeContentFilePath,
  issueProjectContentUrlLocal,
} from "./project-content-url";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const HOST = "33333333-3333-4333-8333-333333333333";
const DOMAIN = "usercontent.example";
const LABELS = `22222222222242228222222222222222.h-33333333333343338333333333333333`;
const NOW = Date.UTC(2026, 9, 18, 12);

let projectRows: any[];
let hostRows: any[];

function readyHost(overrides: Record<string, any> = {}) {
  return {
    bay_id: "bay-0",
    deleted: null,
    metadata: {
      content_dns: {
        name: `*.h-33333333333343338333333333333333.${DOMAIN}`,
        domain: DOMAIN,
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  settingsMock.mockResolvedValue({
    dns: "cocalc.example",
    project_content_dns: DOMAIN,
  });
  bannedMock.mockReturnValue(false);
  resolveProjectBayMock.mockResolvedValue(null);
  projectRows = [{ host_id: HOST, bay_id: "bay-0", group: "collaborator" }];
  hostRows = [readyHost()];
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM projects")) return { rows: projectRows };
    if (sql.includes("FROM project_hosts")) return { rows: hostRows };
    throw new Error(`unexpected query: ${sql}`);
  });
});

function issue(opts: Partial<Parameters<typeof issueProjectContentUrlLocal>[0]> = {}) {
  return issueProjectContentUrlLocal({
    account_id: ACCOUNT,
    project_id: PROJECT,
    path: "/home/user/a dir/a.html",
    now_ms: NOW,
    ...opts,
  });
}

describe("issueProjectContentUrlLocal", () => {
  it("returns a link the host accepts for exactly this project, host and account", async () => {
    const result = await issue();
    if (!("url" in result)) throw new Error(`unavailable: ${result.unavailable}`);
    const url = new URL(result.url);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe(`${LABELS}.${DOMAIN}`);
    const match = url.pathname.match(/^\/_c\/([^/]+)\/files\/(.*)$/);
    expect(match?.[2]).toBe("home/user/a%20dir/a.html");
    const claims = verifyProjectContentCapability({
      token: match![1],
      project_id: PROJECT,
      host_id: HOST,
      public_key: PUBLIC_KEY,
      now_ms: NOW,
    });
    expect(claims).toMatchObject({ sub: ACCOUNT, scope: "read", epoch: 0 });
    expect(result.expires_at).toBe(NOW + 24 * 60 * 60 * 1000);
    expect(claims.exp * 1000).toBe(result.expires_at);
  });

  it("owners get a link too", async () => {
    projectRows[0].group = "owner";
    await expect(issue()).resolves.toHaveProperty("url");
  });

  it.each([["viewer"], [null], ["student"]])(
    "refuses an account in group %p",
    async (group) => {
      projectRows[0].group = group;
      await expect(issue()).rejects.toThrow("not authorized");
    },
  );

  it("refuses a banned account before looking anything up", async () => {
    bannedMock.mockReturnValue(true);
    await expect(issue()).rejects.toThrow("banned");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("is off when no content domain is configured", async () => {
    settingsMock.mockResolvedValue({ dns: "cocalc.example" });
    await expect(issue()).resolves.toEqual({ unavailable: "off" });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("is off when the content domain shares the site's registrable domain", async () => {
    settingsMock.mockResolvedValue({
      dns: "cocalc.example",
      project_content_dns: "content.cocalc.example",
    });
    await expect(issue()).resolves.toEqual({ unavailable: "off" });
  });

  it("reports a project without a host", async () => {
    projectRows[0].host_id = null;
    await expect(issue()).resolves.toEqual({ unavailable: "no-host" });
  });

  it.each([
    ["no recorded DNS", readyHost({ metadata: {} })],
    [
      "DNS recorded for another domain",
      readyHost({
        metadata: {
          content_dns: {
            name: "*.h-33333333333343338333333333333333.old.example",
            domain: "old.example",
          },
        },
      }),
    ],
    ["a deleted host", readyHost({ deleted: new Date() })],
  ])("reports a host that isn't ready: %s", async (_label, host) => {
    hostRows = [host];
    await expect(issue()).resolves.toEqual({ unavailable: "host-not-ready" });
  });

  it("reports a missing host row as not ready", async () => {
    hostRows = [];
    await expect(issue()).resolves.toEqual({ unavailable: "host-not-ready" });
  });

  it("does not sign for a project or host owned by another bay", async () => {
    projectRows[0].bay_id = "bay-1";
    await expect(issue()).resolves.toEqual({ unavailable: "other-bay" });
    projectRows[0].bay_id = "bay-0";
    hostRows = [readyHost({ bay_id: "bay-1" })];
    await expect(issue()).resolves.toEqual({ unavailable: "other-bay" });
    projectRows = [];
    resolveProjectBayMock.mockResolvedValue({ bay_id: "bay-1" });
    await expect(issue()).resolves.toEqual({ unavailable: "other-bay" });
  });

  it("throws for an unknown project", async () => {
    projectRows = [];
    await expect(issue()).rejects.toThrow("project not found");
  });

  it("bounds the link by a restricted browser session", async () => {
    const browser_session_exp_s = NOW / 1000 + 600;
    const result = await issue({ browser_session_exp_s });
    expect(result).toHaveProperty("expires_at", browser_session_exp_s * 1000);
    await expect(
      issue({ browser_session_exp_s: NOW / 1000 + 30 }),
    ).rejects.toThrow("expires too soon");
  });

  it("rejects invalid ids before any lookup", async () => {
    await expect(issue({ project_id: "nope" })).rejects.toThrow("invalid");
    await expect(issue({ account_id: "nope" })).rejects.toThrow("invalid");
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("encodeContentFilePath", () => {
  it("encodes each segment and drops empty ones", () => {
    expect(encodeContentFilePath("/home/user/x#1?.html")).toBe(
      "home/user/x%231%3F.html",
    );
    expect(encodeContentFilePath("a//b/")).toBe("a/b");
  });

  it.each([
    ["empty", ""],
    ["root", "/"],
    ["a parent segment", "a/../b"],
    ["a dot segment", "./a"],
    ["NUL", "a\0b"],
    ["too long", "x".repeat(5000)],
  ])(
    "rejects %s",
    (_label, path) => {
      expect(() => encodeContentFilePath(path)).toThrow("invalid path");
    },
  );
});
