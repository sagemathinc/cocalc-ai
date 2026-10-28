/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { resolveGpuAgentPrincipal } from "./agent-identity";

const ACCOUNT = "00000000-1000-4000-8000-000000000001";
const PROJECT = "00000000-1000-4000-8000-0000000000aa";
const FP = "a".repeat(64);
const NOW = new Date("2026-10-28T12:00:00Z");
const EXP_S = NOW.getTime() / 1000 + 600;

function db({ runs = [] as any[], external = [] as any[] } = {}) {
  const query = jest.fn(async (sql: string, values?: unknown[]) => {
    expect(values).toEqual([FP]);
    if (sql.includes("agent_identity_runs")) return { rows: runs };
    if (sql.includes("agent_external_installations")) return { rows: external };
    throw Error(`unexpected query ${sql}`);
  });
  return { query };
}

const run = (over: any = {}) => ({
  agent_id: "11111111-1000-4000-8000-000000000001",
  run_id: "22222222-1000-4000-8000-000000000002",
  account_id: ACCOUNT,
  project_id: PROJECT,
  expires_at: new Date(NOW.getTime() + 300_000),
  ended_at: null,
  disabled_at: null,
  ...over,
});

const auth = (over: any = {}) => ({
  account_id: ACCOUNT,
  project_id: PROJECT,
  auth_token_fingerprint: FP,
  auth_exp_s: EXP_S,
  ...over,
});

const resolve = (a: any, d: any) =>
  resolveGpuAgentPrincipal(a, { db: d, now: () => NOW });

describe("resolveGpuAgentPrincipal", () => {
  it("maps a registered agent's active run to agent:<id> and its run, ending at the earlier expiry", async () => {
    expect(await resolve(auth(), db({ runs: [run()] }))).toEqual({
      account_id: ACCOUNT,
      project_id: PROJECT,
      agent_id: "agent:11111111-1000-4000-8000-000000000001",
      run_id: "22222222-1000-4000-8000-000000000002",
      expires_at: new Date(NOW.getTime() + 300_000),
    });
  });

  it.each([
    ["another account", { account_id: "00000000-1000-4000-8000-000000000009" }],
    ["another project", { project_id: "00000000-1000-4000-8000-0000000000bb" }],
    ["an ended run", { ended_at: NOW }],
    ["a disabled agent", { disabled_at: NOW }],
    ["an expired run", { expires_at: NOW }],
  ])("refuses a registered agent's run of %s", async (_, over) => {
    await expect(resolve(auth(), db({ runs: [run(over)] }))).rejects.toThrow(
      "isn't active for this project",
    );
  });

  it("refuses an ambiguous fingerprint (more than one run)", async () => {
    await expect(resolve(auth(), db({ runs: [run(), run()] }))).rejects.toThrow(
      "isn't active",
    );
  });

  it("refuses external agent installations", async () => {
    await expect(resolve(auth(), db({ external: [{}] }))).rejects.toThrow(
      "External agents can't launch GPUs",
    );
  });

  it("scopes a project token to its chat session", async () => {
    expect(await resolve(auth(), db())).toEqual({
      account_id: ACCOUNT,
      project_id: PROJECT,
      agent_id: `session:${FP}`,
      run_id: `session:${FP}`,
      expires_at: new Date(EXP_S * 1000),
    });
  });

  it.each([
    ["a missing fingerprint", { auth_token_fingerprint: undefined }],
    ["a malformed fingerprint", { auth_token_fingerprint: "xyz" }],
    ["a bad account", { account_id: "nope" }],
    ["a missing project", { project_id: undefined }],
    ["no expiry", { auth_exp_s: undefined }],
  ])("refuses %s", async (_, over) => {
    const d = db();
    await expect(resolve(auth(over), d)).rejects.toThrow(
      "invalid agent identity",
    );
    expect(d.query).not.toHaveBeenCalled();
  });

  it("refuses an expired token", async () => {
    await expect(
      resolve(auth({ auth_exp_s: NOW.getTime() / 1000 }), db()),
    ).rejects.toThrow("expired");
  });
});
