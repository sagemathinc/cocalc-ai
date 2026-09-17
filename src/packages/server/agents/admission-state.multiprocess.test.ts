/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";

const execFileAsync = promisify(execFile);
const describeMultiprocess =
  process.env.COCALC_AGENT_MULTIPROCESS_POSTGRES === "1"
    ? describe
    : describe.skip;

const worker = String.raw`
const state = JSON.parse(process.env.AGENT_ADMISSION_STATE);
state.expires_at = new Date(state.expires_at);
const api = require(process.env.AGENT_ADMISSION_MODULE);
const db = require('@cocalc/database/pool').default();
(async () => {
  let result;
  if (process.env.AGENT_ADMISSION_ACTION === 'create') {
    await api.createAgentRpcAdmissionState(state);
    result = true;
  } else if (process.env.AGENT_ADMISSION_ACTION === 'claim') {
    result = !!(await api.claimAgentRpcAdmissionState(state));
  } else if (process.env.AGENT_ADMISSION_ACTION === 'get') {
    result = !!(await api.getAgentRpcAdmissionState(state));
  } else {
    await api.deleteAgentRpcAdmissionState(state);
    result = true;
  }
  process.stdout.write(JSON.stringify(result));
  await db.end();
})().catch(async (error) => {
  process.stderr.write(String(error?.stack ?? error));
  await db.end().catch(() => undefined);
  process.exitCode = 1;
});
`;

describeMultiprocess("shared admission state across Node processes", () => {
  beforeAll(async () => {
    process.env.COCALC_AGENT_MESSAGING_ENABLED = "1";
    await syncSchema({
      agent_rpc_admission_state: SCHEMA.agent_rpc_admission_state,
    });
  });

  beforeEach(async () => {
    await getPool().query("DELETE FROM agent_rpc_admission_state");
  });

  afterAll(async () => {
    await getPool().end();
  });

  const state = (kind: "permit" | "preparation") => ({
    token_id: randomUUID(),
    kind,
    binding_hash: "a".repeat(64),
    host_id: randomUUID(),
    project_id: randomUUID(),
    account_id: randomUUID(),
    expires_at: new Date(Date.now() + 30_000).toISOString(),
  });

  async function run(action: string, value: ReturnType<typeof state>) {
    const { stdout } = await execFileAsync(process.execPath, ["-e", worker], {
      cwd: __dirname,
      env: {
        ...process.env,
        COCALC_DB_SKIP_ENSURE_EXISTS: "1",
        AGENT_ADMISSION_ACTION: action,
        AGENT_ADMISSION_STATE: JSON.stringify(value),
        AGENT_ADMISSION_MODULE: resolve(
          __dirname,
          "../dist/agents/admission-state.js",
        ),
      },
    });
    return JSON.parse(stdout);
  }

  test("a permit created in one process is reusable and releasable from others", async () => {
    const permit = state("permit");
    expect(await run("create", permit)).toBe(true);
    expect(await run("get", permit)).toBe(true);
    expect(await run("get", permit)).toBe(true);
    expect(await run("delete", permit)).toBe(true);
    expect(await run("get", permit)).toBe(false);
  });

  test("only one of two separate processes claims a preparation", async () => {
    const preparation = state("preparation");
    await run("create", preparation);
    const claims = await Promise.all([
      run("claim", preparation),
      run("claim", preparation),
    ]);
    expect(claims.sort()).toEqual([false, true]);
  });
});
