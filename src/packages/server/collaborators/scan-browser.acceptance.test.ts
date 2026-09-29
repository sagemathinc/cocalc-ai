/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { MultibayAcceptance } from "./acceptance/harness";
const execute = promisify(execFile);
const acceptance =
  process.env.COCALC_COLLABORATORS_ACCEPTANCE === "1"
    ? describe
    : describe.skip;

acceptance("Scan browser against real home, owner and host services", () => {
  let env: MultibayAcceptance;
  let bridge: Server | undefined;
  const unavailable = randomUUID();
  beforeAll(async () => {
    env = new MultibayAcceptance({ explicitCensus: true });
    await env.start();
    for (const role of ["owner", "a", "b"] as const) {
      await env.worker(role).call("installManualScan");
      await env.sql(
        role,
        "UPDATE projects SET title='Available storage' WHERE project_id=$1",
        [env.project],
      );
      await env.sql(
        role,
        "UPDATE account_project_index SET title='Available storage' WHERE project_id=$1",
        [env.project],
      );
    }
    await env.sql(
      "owner",
      "INSERT INTO project_hosts(id,bay_id) VALUES($1,$2)",
      [env.host, env.bays[0]],
    );
    for (const role of ["owner", "b"] as const)
      await env.sql(
        role,
        "INSERT INTO projects(project_id,owning_bay_id,users,title) VALUES($1,$2,$3::jsonb,'Unavailable storage')",
        [
          unavailable,
          env.bays[2],
          JSON.stringify({ [env.accounts[0]]: { group: "collaborator" } }),
        ],
      );
    await env.sql(
      "a",
      "INSERT INTO account_project_index(account_id,project_id,owning_bay_id,users_summary,title,sort_key) VALUES($1,$2,$3,$4::jsonb,'Unavailable storage',now())",
      [
        env.accounts[0],
        unavailable,
        env.bays[2],
        JSON.stringify({ [env.accounts[0]]: { group: "collaborator" } }),
      ],
    );
    await env.worker("host").call("explicitCensusFixture");
  }, 240000);
  afterAll(async () => {
    if (bridge)
      await new Promise<void>((resolve) => bridge!.close(() => resolve()));
    await env?.close();
  }, 60000);
  test("search, select-all, progress, reload, actual cooldown, explicit retry and cancellation", async () => {
    const errors: string[] = [];
    let firstWorkerStarted = false;
    let secondWorkerStarted = false;
    bridge = createServer(async (req, res) => {
      try {
        if (
          req.method !== "POST" ||
          !["/rpc", "/rpc/second"].includes(req.url ?? "")
        ) {
          res.statusCode = 404;
          res.end();
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const request = JSON.parse(body);
        const second = req.url === "/rpc/second";
        // Browser carries no account credentials. This isolated bridge binds
        // each test browser actor to its fixture principal before the real API.
        const result = second
          ? await env.hub("b", "scanProjects", request)
          : await env
              .worker("b")
              .call("scanPublic", { method: "scanProjects", request });
        if (!second && request.action === "start" && !firstWorkerStarted) {
          firstWorkerStarted = true;
          await env.worker("a").call("startScanMaintenance");
        }
        if (second && request.action === "cancel" && !secondWorkerStarted) {
          secondWorkerStarted = true;
          await env.worker("b").call("startScanMaintenance");
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
      } catch (err) {
        errors.push(String(err));
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "Acceptance service RPC failed" }));
      }
    });
    await new Promise<void>((resolve) =>
      bridge!.listen(0, "127.0.0.1", resolve),
    );
    const address = bridge.address();
    if (!address || typeof address === "string")
      throw Error("bridge address unavailable");
    const output = await execute(
      process.execPath,
      [
        resolve(
          __dirname,
          "../../../scripts/accessibility/manual-scan-service.mjs",
        ),
        `http://127.0.0.1:${address.port}`,
        env.project,
        unavailable,
      ],
      { timeout: 240000, maxBuffer: 100000 },
    );
    expect(JSON.parse(output.stdout.trim())).toEqual({
      passed: true,
      starts: ["all", [unavailable]],
      cancelled: true,
      reloaded: true,
    });
    expect(errors).toEqual([]);
    for (const role of ["owner", "a", "b"] as const)
      expect((await env.worker(role).call("inspect")).counters.starts).toBe(0);
  }, 300000);
});
