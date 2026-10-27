/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// End-to-end multibay checks against a real two-bay cluster: a seed (bay-0)
// and an attached bay (bay-1), each a full hub with its own Postgres, joined
// by the real inter-bay fabric. Requires a built tree (`pnpm build`) and
// PostgreSQL server binaries on PATH or discoverable via pg_config.
//
//   node --test src/scripts/multibay/multibay.test.mjs
//
// MULTIBAY_KEEP=1 keeps the cluster's directory (logs, databases) afterwards.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { MultibayCluster, SRC } from "./cluster.mjs";
import {
  AccountClient,
  connectBayDatabase,
  createAccount,
  eventually,
  runInBay,
} from "./harness.mjs";

const SEED = "bay-0";
const ATTACHED = "bay-1";

const cluster = new MultibayCluster({ bayIds: [SEED, ATTACHED] });
let alice; // homed on the seed
let bob; // homed on the attached bay
const clients = [];

async function client(account) {
  const c = await new AccountClient(cluster, account).ready();
  clients.push(c);
  return c;
}

async function projectList(c) {
  return await c.call("projects.listAccountProjectWindow", { limit: 200 });
}

async function listed(c, project_id) {
  return (await projectList(c)).find((row) => row.project_id === project_id);
}

async function owningBay(project_id) {
  for (const bay of cluster.bayIds) {
    const owner = await runInBay(
      cluster,
      bay,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT owning_bay_id FROM projects WHERE project_id=$1 AND owning_bay_id=$2",
         [${JSON.stringify(project_id)}, ${JSON.stringify(bay)}]);
       return rows[0]?.owning_bay_id ?? null;`,
    );
    if (owner) return owner;
  }
  return null;
}

/** Hold the seed's bay credential registry unreadable for `seconds`. */
async function lockCredentialRegistry(seconds) {
  await runInBay(
    cluster,
    SEED,
    `const getPool = require("@cocalc/database/pool").default;
     const db = await getPool().connect();
     try {
       await db.query("BEGIN");
       await db.query("LOCK TABLE cluster_bay_credentials IN ACCESS EXCLUSIVE MODE");
       await db.query("SELECT pg_sleep($1)", [${seconds}]);
       await db.query("COMMIT");
     } finally {
       db.release();
     }`,
    { timeoutMs: (seconds + 60) * 1000 },
  );
}

function seedLog() {
  return readFileSync(cluster.bay(SEED).debugFile, "utf8");
}

/**
 * The owner invites; the invitee finds the invite through their own home bay
 * and accepts it, as in the UI.
 */
async function invite(owner, invitee, project_id) {
  const { invite } = await owner.client.call("projects.createCollabInvite", {
    project_id,
    invitee_account_id: invitee.account_id,
  });
  const inbound = await eventually(
    async () =>
      (
        await invitee.client.call("projects.listCollabInvites", {
          direction: "inbound",
          status: "pending",
        })
      ).find((row) => row.invite_id === invite.invite_id),
    { what: "the invite in the invitee's inbox" },
  );
  await invitee.client.call("projects.respondCollabInvite", {
    invite_id: inbound.invite_id,
    project_id,
    action: "accept",
  });
}

async function createProject(c, title) {
  return await c.call("projects.createProject", {
    title,
    start: false,
  });
}

async function rename(c, project_id, title) {
  await c.call("projects.setProjectMetadata", {
    project_id,
    patch: { title },
  });
}

/** A change made through one bay is visible to an account homed on the other. */
async function assertCrossBayRename(actor, viewer, project_id, title) {
  // Right after a fabric fault a call may time out while the bays reconnect;
  // what must hold is that the change lands without restarting anything.
  await eventually(
    async () => {
      await rename(actor, project_id, title);
      return true;
    },
    { timeoutMs: 120_000, intervalMs: 1_000, what: `the rename to ${title}` },
  );
  await eventually(
    async () => (await listed(viewer, project_id))?.title === title,
    {
      timeoutMs: 60_000,
      what: `${title} to reach the other bay`,
    },
  );
}

before(async () => {
  await cluster.init();
  await cluster.start();
  alice = await createAccount(cluster, { home_bay_id: SEED, name: "alice" });
  bob = await createAccount(cluster, { home_bay_id: ATTACHED, name: "bob" });
  alice.client = await client(alice);
  bob.client = await client(bob);
});

after(async () => {
  for (const c of clients) c.close();
  await cluster.stop();
});

describe("routing by ownership", () => {
  it("resolves each account to its home bay", async () => {
    const a = await alice.client.call("system.getAccountBay", {});
    const b = await bob.client.call("system.getAccountBay", {});
    assert.equal(a.home_bay_id, SEED);
    assert.equal(b.home_bay_id, ATTACHED);
  });

  it("creates each account's projects on its home bay", async () => {
    alice.project = await createProject(alice.client, "alice-project");
    bob.project = await createProject(bob.client, "bob-project");
    assert.equal(await owningBay(alice.project), SEED);
    assert.equal(await owningBay(bob.project), ATTACHED);
    await eventually(() => listed(alice.client, alice.project), {
      what: "alice's own project in her list",
    });
    await eventually(() => listed(bob.client, bob.project), {
      what: "bob's own project in his list",
    });
  });
});

describe("agent delivery reports across bays", () => {
  // The seed forwards a report about a message to the bay that owns the
  // sender's project, over the real fabric; only that bay may write it, and
  // only with the capability a hub of this cluster minted for the message.
  async function deliverFromSeed({
    project_id,
    forged = false,
    agent_id = randomUUID(),
    kind = "error",
    tool_ran,
    phase,
    attempt_id = randomUUID(),
  }) {
    const report = {
      version: 1,
      report_id: randomUUID(),
      attempt_id,
      turn_started_at: Date.now() - 60_000,
      kind,
      ...(tool_ran === undefined ? {} : { tool_ran }),
      ...(phase ? { phase, resets_at: Date.now() + 3_600_000 } : {}),
    };
    return await runInBay(
      cluster,
      SEED,
      `const { getInterBayFabricClient } = server("inter-bay/fabric.js");
       const { resolveProjectBay } = server("inter-bay/directory.js");
       const { signAgentRpcReportCapability } = server("agents/rpc-report-capability.js");
       const { createAgentRpcControlClient } = require("@cocalc/conat/inter-bay/agent-rpc");
       const report = ${JSON.stringify(report)};
       const project_id = ${JSON.stringify(project_id)};
       report.authorization = {
         version: 3,
         source: { project_id, agent_id: ${JSON.stringify(agent_id)} },
         source_run_id: ${JSON.stringify(randomUUID())},
         target: { project_id: ${JSON.stringify(alice.project)}, agent_id: ${JSON.stringify(randomUUID())} },
         target_path: "/home/user/b.chat",
         target_thread_id: "thread-b",
         agent_network_id: ${JSON.stringify(randomUUID())},
         network_generation: ${JSON.stringify(randomUUID())},
         account_generation: 1,
         configured_delivery: "queued",
         principal_account_id: ${JSON.stringify(bob.account_id)},
         guidance: false,
         attempt_id: report.attempt_id,
       };
       report.authorization.report_capability = ${forged}
         ? Date.now() + "." + "A".repeat(43)
         : signAgentRpcReportCapability(report.authorization);
       const route = await resolveProjectBay(project_id);
       try {
         await createAgentRpcControlClient(getInterBayFabricClient(), ${JSON.stringify(ATTACHED)}).deliverReport({
           project_id,
           route: { bay_id: ${JSON.stringify(ATTACHED)}, epoch: route.epoch },
           account_id: ${JSON.stringify(bob.account_id)},
           report,
           target_label: "@reviewer",
         });
         return "delivered";
       } catch (err) {
         return String(err?.message ?? err);
       }`,
    );
  }

  it("refuses a report for a project the bay does not own", async () => {
    assert.match(
      await deliverFromSeed({ project_id: alice.project }),
      /stale agent RPC route/,
    );
  });

  it("refuses a report without a capability this cluster minted", async () => {
    assert.match(
      await deliverFromSeed({ project_id: bob.project, forged: true }),
      /does not match an admitted message/,
    );
  });

  it("accepts the seed's capability and looks the sender up where it lives", async () => {
    // No agent is registered in this cluster: reaching the owning bay's own
    // identity lookup means routing and the capability were accepted.
    assert.match(
      await deliverFromSeed({ project_id: bob.project }),
      /agent not found/,
    );
  });

  describe("held or downgraded for what the sender's host can render", () => {
    // The sender's agent and host live on the attached bay; the seed
    // forwards. Holding is decided there, from the host's own heartbeat
    // metadata (its advertised report version, for the build it runs).
    const agent_id = randomUUID();
    const hosts = {
      old: { software: { project_host: "build-1" } },
      "rolled back": {
        software: { project_host: "build-1" },
        agent_rpc_report: { version: 2, project_host: "build-2" },
      },
      current: {
        software: { project_host: "build-2" },
        agent_rpc_report: { version: 2, project_host: "build-2" },
      },
      // Knows completed reports (version 3), not held ones (4).
      "completed-report": {
        software: { project_host: "build-3" },
        agent_rpc_report: { version: 3, project_host: "build-3" },
      },
      "held-report": {
        software: { project_host: "build-4" },
        agent_rpc_report: { version: 4, project_host: "build-4" },
      },
    };
    const hostIds = Object.fromEntries(
      Object.keys(hosts).map((name) => [name, randomUUID()]),
    );
    let project_id;

    before(async () => {
      project_id = await createProject(bob.client, "bob-report-sender");
      assert.equal(await owningBay(project_id), ATTACHED);
      await runInBay(
        cluster,
        ATTACHED,
        `const getPool = require("@cocalc/database/pool").default;
         const pool = getPool();
         await pool.query(
           "INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by) VALUES ($1,$2,$3,$4,$5,$6)",
           [${JSON.stringify(agent_id)}, ${JSON.stringify(project_id)}, "/home/user/a.chat", "thread-a", "sender", ${JSON.stringify(bob.account_id)}],
         );
         const hosts = ${JSON.stringify(hosts)};
         const ids = ${JSON.stringify(hostIds)};
         for (const [name, metadata] of Object.entries(hosts))
           await pool.query(
             "INSERT INTO project_hosts (id, name, status, bay_id, metadata, created, updated) VALUES ($1, $2, 'off', $3, $4, NOW(), NOW())",
             [ids[name], "report host " + name, ${JSON.stringify(ATTACHED)}, metadata],
           );`,
      );
    });

    async function onHost(name) {
      await runInBay(
        cluster,
        ATTACHED,
        `await require("@cocalc/database/pool").default().query(
           "UPDATE projects SET host_id=$1 WHERE project_id=$2",
           [${JSON.stringify(hostIds[name])}, ${JSON.stringify(project_id)}],
         );`,
      );
    }
    const held = /must be upgraded before it can receive this report/;
    // Past the version check, the report goes to the host, which does not
    // run here: it failed at the host, not at the version check.
    const forwarded = (result) =>
      assert.ok(
        result !== "delivered" &&
          !held.test(result) &&
          !/agent not found|does not match|stale agent RPC route/.test(result),
        result,
      );

    for (const name of ["old", "rolled back"]) {
      it(`holds a report that ran tools for a${name === "old" ? "n" : ""} ${name} host`, async () => {
        await onHost(name);
        for (const report of [
          { kind: "canceled", tool_ran: true },
          { kind: "error", tool_ran: true },
          { kind: "error" },
        ])
          assert.match(
            await deliverFromSeed({ project_id, agent_id, ...report }),
            held,
          );
      });

      it(`downgrades one that ran nothing for a${name === "old" ? "n" : ""} ${name} host`, async () => {
        await onHost(name);
        forwarded(
          await deliverFromSeed({
            project_id,
            agent_id,
            kind: "canceled",
            tool_ran: false,
          }),
        );
      });
    }

    it("holds a held report for a host that predates it", async () => {
      for (const name of ["old", "current", "completed-report"]) {
        await onHost(name);
        assert.match(
          await deliverFromSeed({
            project_id,
            agent_id,
            kind: "limit",
            tool_ran: false,
            phase: "held",
          }),
          held,
        );
      }
    });

    it("forwards a held report and then the final one to a host that knows them", async () => {
      await onHost("held-report");
      const attempt_id = randomUUID();
      for (const phase of ["held", undefined])
        forwarded(
          await deliverFromSeed({
            project_id,
            agent_id,
            attempt_id,
            kind: "limit",
            tool_ran: false,
            ...(phase ? { phase } : {}),
          }),
        );
    });

    it("forwards a completed report to a version-3 host", async () => {
      await onHost("completed-report");
      forwarded(
        await deliverFromSeed({
          project_id,
          agent_id,
          kind: "completed",
          tool_ran: true,
        }),
      );
    });

    it("forwards every report to a current host", async () => {
      await onHost("current");
      forwarded(
        await deliverFromSeed({
          project_id,
          agent_id,
          kind: "canceled",
          tool_ran: true,
        }),
      );
    });
  });
});

describe("a held sign-in turn asks the account's home bay (I4c)", () => {
  // The project (and its host) on the seed; the turn's account (bob) homed
  // on the attached bay, where its credentials live. The seed answers the
  // host from bob's home bay, with times only.
  const host_id = randomUUID();
  let project_id;
  let credential_id;
  const selector = () => ({
    provider: "anthropic",
    kind: "claude-subscription",
    scope: "account",
    owner_account_id: bob.account_id,
  });
  const ask = async () =>
    await runInBay(
      cluster,
      SEED,
      `return await server("agents/api.js").credentialUpdatedAt(${JSON.stringify(
        {
          host_id,
          account_id: bob.account_id,
          project_id: "PROJECT",
          credential_id: "CREDENTIAL",
          provider: "anthropic",
        },
      )
        .replace('"PROJECT"', JSON.stringify(project_id))
        .replace('"CREDENTIAL"', JSON.stringify(credential_id))});`,
    );
  const onHome = async (body) => await runInBay(cluster, ATTACHED, body);

  before(async () => {
    // Its own owner: alice's project limit is needed by later scenarios.
    const owner = await createAccount(cluster, {
      home_bay_id: SEED,
      name: "olive",
    });
    project_id = await createProject(await client(owner), "signin-hold");
    assert.equal(await owningBay(project_id), SEED);
    await runInBay(
      cluster,
      SEED,
      `const pool = require("@cocalc/database/pool").default();
       await pool.query(
         "INSERT INTO project_hosts (id, name, status, bay_id, metadata, created, updated) VALUES ($1, 'signin host', 'off', $2, '{}', NOW(), NOW())",
         [${JSON.stringify(host_id)}, ${JSON.stringify(SEED)}],
       );
       await pool.query(
         "UPDATE projects SET host_id=$1, users = users || jsonb_build_object($3::text, jsonb_build_object('group','collaborator')) WHERE project_id=$2",
         [${JSON.stringify(host_id)}, ${JSON.stringify(project_id)}, ${JSON.stringify(bob.account_id)}],
       );`,
    );
    credential_id = (
      await onHome(
        `return await server("external-credentials/store.js").createExternalCredential({
           selector: ${JSON.stringify(selector())},
           payload: "not-a-real-token",
           metadata: { label: "Max A" },
         });`,
      )
    ).id;
  });

  it("sees a new sign-in and a revoke on the other bay, never the secret", async () => {
    const first = await ask();
    assert.equal(first.revoked, false);
    assert.equal(typeof first.updated_at, "number");
    assert.equal(first.newest_updated_at, first.updated_at);
    assert.doesNotMatch(JSON.stringify(first), /not-a-real-token|Max A/);
    await sleep(50);
    // A label edit stands in for signing in again: it updates the row.
    await onHome(
      `return await server("external-credentials/store.js").updateExternalCredentialLabelById({
         id: ${JSON.stringify(credential_id)},
         selector: ${JSON.stringify(selector())},
         label: "Max B",
       });`,
    );
    const updated = await ask();
    assert.ok(updated.updated_at > first.updated_at, JSON.stringify(updated));
    await onHome(
      `return await server("external-credentials/store.js").revokeExternalCredential({
         id: ${JSON.stringify(credential_id)},
         owner_account_id: ${JSON.stringify(bob.account_id)},
       });`,
    );
    const revoked = await ask();
    assert.equal(revoked.revoked, true);
    // No unrevoked credential of that kind is left to resume with.
    assert.equal(revoked.newest_updated_at, undefined);
    assert.equal(revoked.newest_credential_id, undefined);
    // Signing in again as a new credential: the held turn learns its id
    // (only the id), to run with it instead of the revoked one.
    const replacement = (
      await onHome(
        `return await server("external-credentials/store.js").createExternalCredential({
           selector: ${JSON.stringify(selector())},
           payload: "another-fake-token",
           metadata: { label: "Max C" },
         });`,
      )
    ).id;
    const replaced = await ask();
    assert.equal(replaced.revoked, true);
    assert.equal(replaced.newest_credential_id, replacement);
    assert.equal(typeof replaced.newest_updated_at, "number");
    assert.doesNotMatch(
      JSON.stringify(replaced),
      /another-fake-token|not-a-real-token|Max [ABC]/,
    );
  });

  it("refuses a host that does not run the project", async () => {
    const other = randomUUID();
    await assert.rejects(
      runInBay(
        cluster,
        SEED,
        `return await server("agents/api.js").credentialUpdatedAt({
           host_id: ${JSON.stringify(other)},
           account_id: ${JSON.stringify(bob.account_id)},
           project_id: ${JSON.stringify(project_id)},
           credential_id: ${JSON.stringify(credential_id)},
         });`,
      ),
    );
  });
});

describe("inspecting a sent message's turn across bays", () => {
  // The sender's agent runs in a seed-owned project; the recipient's project
  // (and its host) live on the attached bay, which is also the account's
  // home (its Agent Network). Inspect crosses from the seed to the
  // recipient's bay, which checks the network (asking the seed for the
  // sender's run) and asks the recipient's host for the turn. That host is a
  // stand-in serving the host-control subject, so what comes back from a
  // real host's answer is checked, not just routed.
  let rita;
  let quinn;
  let sender_project;
  let target_project;
  const sender = randomUUID();
  const recipient = randomUUID();
  const run = randomUUID();
  const network = randomUUID();
  const host_id = randomUUID();
  const attempts = {
    held: randomUUID(),
    foreign: randomUUID(),
    malformed: randomUUID(),
  };
  const turn = {
    state: "queued",
    held: true,
    queued_at: 1_792_000_000_000,
    started_at: 1_792_000_001_000,
    tool_ran: true,
  };

  before(async () => {
    quinn = await createAccount(cluster, { home_bay_id: SEED, name: "quinn" });
    quinn.client = await client(quinn);
    rita = await createAccount(cluster, {
      home_bay_id: ATTACHED,
      name: "rita",
    });
    rita.client = await client(rita);
    sender_project = await createProject(quinn.client, "inspect-sender");
    await invite(quinn, rita, sender_project);
    await eventually(() => listed(rita.client, sender_project), {
      what: "the sender project in rita's list",
    });
    assert.equal(await owningBay(sender_project), SEED);
    target_project = await createProject(rita.client, "inspect-recipient");
    assert.equal(await owningBay(target_project), ATTACHED);
    // The sender's agent and an issued run, on the seed.
    await runInBay(
      cluster,
      SEED,
      `const getPool = require("@cocalc/database/pool").default;
       const { agentStore } = server("agents/store.js");
       await getPool().query(
         "INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by) VALUES($1,$2,'/home/user/agents.chat','sender','claude-1',$3)",
         [${JSON.stringify(sender)}, ${JSON.stringify(sender_project)}, ${JSON.stringify(rita.account_id)}]);
       const db = agentStore();
       await db.issue(await db.get(${JSON.stringify(sender)}), ${JSON.stringify(run)}, ${JSON.stringify(rita.account_id)});`,
    );
    // The recipient's agent, its host, rita's names and network: all on the
    // attached bay.
    await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       const account = ${JSON.stringify(rita.account_id)};
       const target = ${JSON.stringify(target_project)};
       const sender = [${JSON.stringify(sender)}, ${JSON.stringify(sender_project)}, "sender"];
       const recipient = [${JSON.stringify(recipient)}, target, "recipient"];
       await getPool().query(
         "INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by) VALUES($1,$2,'/home/user/agents.chat','recipient','claude-2',$3)",
         [recipient[0], target, account]);
       await getPool().query(
         "INSERT INTO project_hosts (id, name, status, bay_id, metadata, created, updated) VALUES ($1, 'inspect host', 'running', $2, '{}', NOW(), NOW())",
         [${JSON.stringify(host_id)}, ${JSON.stringify(ATTACHED)}]);
       await getPool().query("UPDATE projects SET host_id=$1 WHERE project_id=$2", [${JSON.stringify(host_id)}, target]);
       for (const [id, project, thread] of [sender, recipient])
         await getPool().query(
           "INSERT INTO agent_personal_names(account_id,name,project_id,agent_id,metadata) VALUES($1,$2,$3,$4,$5)",
           [account, thread, project, id, { path: "/home/user/agents.chat", thread_id: thread }]);
       await getPool().query(
         "INSERT INTO agent_networks(agent_network_id,account_id,title,generation,created_by,delivery_mode) VALUES($1,$2,'inspect',$3,$2,'queued')",
         [${JSON.stringify(network)}, account, ${JSON.stringify(randomUUID())}]);
       for (const [id, project] of [sender, recipient])
         await getPool().query(
           "INSERT INTO agent_network_members(agent_network_id,member_kind,member_id,registered_agent_id,project_id,added_by) VALUES($1,'registered',$2,$2,$3,$4)",
           [${JSON.stringify(network)}, id, project, account]);
       await getPool().query("CREATE TABLE IF NOT EXISTS multibay_fake_host (key TEXT PRIMARY KEY, value JSONB)");`,
    );
  });

  /**
   * A stand-in for the recipient's project host. It serves until the test
   * writes a `stop` row (see stopFakeHost), or at most `lifetimeMs`.
   */
  function fakeHost(lifetimeMs = 100_000) {
    return runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       const { conat } = require("@cocalc/backend/conat");
       const { createHostControlService } = require("@cocalc/conat/project-host/api");
       const attempts = ${JSON.stringify(attempts)};
       const turn = ${JSON.stringify(turn)};
       const note = (key, value) =>
         getPool().query(
           "INSERT INTO multibay_fake_host(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
           [key, JSON.stringify(value)]);
       const service = createHostControlService({
         host_id: ${JSON.stringify(host_id)},
         client: conat(),
         impl: {
           inspectAgentRpc: async ({ source, request, account_id }) => {
             await note(request.attempt_id, { source, account_id });
             const answer = {
               version: 3,
               attempt_id: request.attempt_id,
               agent_network_id: request.agent_network_id,
               target: request.target,
               outcome: "accepted",
               observed_at: Date.now(),
               turn,
             };
             // Another conversation's turn, or one that is not a turn.
             if (request.attempt_id === attempts.foreign)
               return { ...answer, target: { ...request.target, agent_id: ${JSON.stringify(randomUUID())} } };
             if (request.attempt_id === attempts.malformed)
               return { ...answer, turn: { state: "paused", queued_at: -1 } };
             return answer;
           },
           withdrawAgentRpc: async ({ source, request, account_id }) => {
             await note("withdraw:" + request.attempt_id, { source, account_id });
             const answer = {
               version: 3,
               attempt_id: request.attempt_id,
               agent_network_id: request.agent_network_id,
               target: request.target,
               outcome: "accepted",
               observed_at: Date.now(),
               reason: "Withdrawn: its turn will not run",
             };
             if (request.attempt_id === attempts.foreign)
               return { ...answer, target: { ...request.target, agent_id: ${JSON.stringify(randomUUID())} } };
             return answer;
           },
         },
       });
       await new Promise((resolve) => setTimeout(resolve, 2_000));
       await note("ready", true);
       const deadline = Date.now() + ${lifetimeMs};
       while (Date.now() < deadline) {
         const { rows } = await getPool().query("SELECT 1 FROM multibay_fake_host WHERE key='stop'");
         if (rows.length > 0) break;
         await new Promise((resolve) => setTimeout(resolve, 200));
       }
       service.close();
       return "served";`,
      // Its own process: it serves for a while.
      { timeoutMs: lifetimeMs + 60_000, fresh: true },
    );
  }

  /**
   * Clear a previous fake host's signals, then start a new one. Its promise
   * is wrapped: an async function would otherwise wait for the host to exit.
   */
  async function startFakeHost(db) {
    await db.query(
      "DELETE FROM multibay_fake_host WHERE key IN ('ready', 'stop')",
    );
    return { exited: fakeHost() };
  }

  /** Tell the fake host to stop, then wait for it to exit. */
  async function stopFakeHost(db, host) {
    await db.query(
      "INSERT INTO multibay_fake_host(key,value) VALUES('stop','true') ON CONFLICT (key) DO NOTHING",
    );
    await host.exited;
  }

  async function inspectFromSeed(attempt_id, run_id = run, action = "inspect") {
    return await runInBay(
      cluster,
      SEED,
      `const { getInterBayFabricClient } = server("inter-bay/fabric.js");
       const { resolveProjectBay } = server("inter-bay/directory.js");
       const { createAgentRpcControlClient } = require("@cocalc/conat/inter-bay/agent-rpc");
       const project_id = ${JSON.stringify(target_project)};
       const route = await resolveProjectBay(project_id);
       return await createAgentRpcControlClient(getInterBayFabricClient(), ${JSON.stringify(ATTACHED)})[${JSON.stringify(action)}]({
         project_id,
         route: { bay_id: route.bay_id, epoch: route.epoch },
         account_id: ${JSON.stringify(rita.account_id)},
         source: { project_id: ${JSON.stringify(sender_project)}, agent_id: ${JSON.stringify(sender)} },
         run_id: ${JSON.stringify(run_id)},
         request: {
           version: 3,
           attempt_id: ${JSON.stringify(attempt_id)},
           agent_network_id: ${JSON.stringify(network)},
           target: { project_id, agent_id: ${JSON.stringify(recipient)} },
         },
       });`,
    );
  }

  it("returns the recipient host's turn, checked, and only for the right turn", async () => {
    const db = await connectBayDatabase(cluster, ATTACHED);
    const host = await startFakeHost(db);
    try {
      await eventually(
        async () =>
          (await db.query("SELECT 1 FROM multibay_fake_host WHERE key='ready'"))
            .rows.length > 0,
        { timeoutMs: 90_000, intervalMs: 1_000, what: "the fake host" },
      );
      // The held turn comes back as the host told it.
      const held = await inspectFromSeed(attempts.held);
      assert.equal(held.outcome, "accepted", JSON.stringify(held));
      assert.deepEqual(held.turn, turn);
      // The host was asked for the sender's turn, as the account's.
      const asked = (
        await db.query("SELECT value FROM multibay_fake_host WHERE key=$1", [
          attempts.held,
        ])
      ).rows[0]?.value;
      assert.deepEqual(asked, {
        source: { project_id: sender_project, agent_id: sender },
        account_id: rita.account_id,
      });
      // Another conversation's turn, or a malformed one, never comes back.
      for (const attempt of [attempts.foreign, attempts.malformed]) {
        const answer = await inspectFromSeed(attempt);
        assert.equal(answer.outcome, "unknown", JSON.stringify(answer));
        assert.equal(answer.turn, undefined);
      }
      // A run the sender's bay never issued: refused at the network check,
      // so the host is never even asked.
      const forged = randomUUID();
      await assert.rejects(
        inspectFromSeed(forged, randomUUID()),
        /expired, revoked, or invalid/,
      );
      assert.equal(
        (
          await db.query("SELECT 1 FROM multibay_fake_host WHERE key=$1", [
            forged,
          ])
        ).rows.length,
        0,
      );
    } finally {
      try {
        await stopFakeHost(db, host);
      } finally {
        // Even if the fake host failed: an open client keeps the run alive.
        await db.end();
      }
    }
  });
  it("withdraws through the recipient's bay and host, and only the right turn", async () => {
    const db = await connectBayDatabase(cluster, ATTACHED);
    const host = await startFakeHost(db);
    try {
      await eventually(
        async () =>
          (await db.query("SELECT 1 FROM multibay_fake_host WHERE key='ready'"))
            .rows.length > 0,
        { timeoutMs: 90_000, intervalMs: 1_000, what: "the fake host" },
      );
      const withdrawn = await inspectFromSeed(attempts.held, run, "withdraw");
      assert.equal(withdrawn.outcome, "accepted", JSON.stringify(withdrawn));
      assert.equal(withdrawn.reason, "Withdrawn: its turn will not run");
      // The recipient's host was asked to withdraw the sender's turn, as the
      // account's.
      const asked = (
        await db.query("SELECT value FROM multibay_fake_host WHERE key=$1", [
          `withdraw:${attempts.held}`,
        ])
      ).rows[0]?.value;
      assert.deepEqual(asked, {
        source: { project_id: sender_project, agent_id: sender },
        account_id: rita.account_id,
      });
      // An answer about another conversation's turn is not believed.
      const foreign = await inspectFromSeed(attempts.foreign, run, "withdraw");
      assert.equal(foreign.outcome, "unknown", JSON.stringify(foreign));
      // A run the sender's bay never issued is refused before the host.
      const forged = randomUUID();
      await assert.rejects(
        inspectFromSeed(forged, randomUUID(), "withdraw"),
        /expired, revoked, or invalid/,
      );
      assert.equal(
        (
          await db.query("SELECT 1 FROM multibay_fake_host WHERE key=$1", [
            `withdraw:${forged}`,
          ])
        ).rows.length,
        0,
      );
    } finally {
      try {
        await stopFakeHost(db, host);
      } finally {
        // Even if the fake host failed: an open client keeps the run alive.
        await db.end();
      }
    }
  });
});

describe("an agent's status across bays", () => {
  // The agent's project (and the host reporting its status) on the seed;
  // the account that named it homed on the attached bay. The host's report
  // reaches that account's name book over the fabric, as that account's
  // own view: its own sign-in block, and never another account's.
  let tess;
  let project;
  const agent = randomUUID();
  const host_id = randomUUID();
  const other = randomUUID();

  before(async () => {
    const owner = await createAccount(cluster, {
      home_bay_id: SEED,
      name: "uma",
    });
    owner.client = await client(owner);
    tess = await createAccount(cluster, {
      home_bay_id: ATTACHED,
      name: "tess",
    });
    tess.client = await client(tess);
    project = await createProject(owner.client, "agent-status");
    await invite(owner, tess, project);
    await eventually(() => listed(tess.client, project), {
      what: "the project in tess's list",
    });
    assert.equal(await owningBay(project), SEED);
    await runInBay(
      cluster,
      SEED,
      `const getPool = require("@cocalc/database/pool").default;
       const pool = getPool();
       await pool.query(
         "INSERT INTO project_hosts (id, name, status, bay_id, metadata, created, updated) VALUES ($1, 'status host', 'running', $2, '{}', NOW(), NOW())",
         [${JSON.stringify(host_id)}, ${JSON.stringify(SEED)}]);
       await pool.query("UPDATE projects SET host_id=$1 WHERE project_id=$2",
         [${JSON.stringify(host_id)}, ${JSON.stringify(project)}]);
       await pool.query(
         "INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by) VALUES($1,$2,'/home/user/s.chat','status','claude-1',$3)",
         [${JSON.stringify(agent)}, ${JSON.stringify(project)}, ${JSON.stringify(tess.account_id)}]);
       await pool.query(
         "INSERT INTO agent_identity_watchers(agent_id,account_id,project_id) VALUES($1,$2,$3)",
         [${JSON.stringify(agent)}, ${JSON.stringify(tess.account_id)}, ${JSON.stringify(project)}]);`,
    );
    await runInBay(
      cluster,
      ATTACHED,
      `await require("@cocalc/database/pool").default().query(
         "INSERT INTO agent_personal_names(account_id,name,project_id,agent_id,metadata) VALUES($1,'statusbot',$2,$3,$4)",
         [${JSON.stringify(tess.account_id)}, ${JSON.stringify(project)}, ${JSON.stringify(agent)},
          { path: "/home/user/s.chat", thread_id: "status" }]);`,
    );
  });

  it("reaches the watcher's home bay as its own view only", async () => {
    const at = Date.now();
    assert.deepEqual(
      await runInBay(
        cluster,
        SEED,
        // reportStatus notifies watchers without waiting; this snippet's
        // process exits when it returns, so it waits for that same push.
        `const result = await server("agents/api.js").reportStatus({
           host_id: ${JSON.stringify(host_id)},
           account_id: ${JSON.stringify(tess.account_id)},
           project_id: ${JSON.stringify(project)},
           path: "/home/user/s.chat",
           thread_id: "status",
           status: {
             version: 1,
             running: 0,
             queued: 0,
             by_account: {
               ${JSON.stringify(tess.account_id)}: { reason: "sign-in" },
               ${JSON.stringify(other)}: { reason: "limit" },
             },
             at: ${at},
           },
         });
         await server("agents/identity-watchers.js").notifyIdentityWatchers(${JSON.stringify(agent)});
         return result;`,
      ),
      { registered: true },
    );
    const db = await connectBayDatabase(cluster, ATTACHED);
    try {
      const status = await eventually(
        async () =>
          (
            await db.query(
              "SELECT metadata->'status' AS status FROM agent_personal_names WHERE account_id=$1 AND agent_id=$2",
              [tess.account_id, agent],
            )
          ).rows[0]?.status ?? undefined,
        {
          timeoutMs: 60_000,
          intervalMs: 1_000,
          what: "the status at tess's home",
        },
      );
      assert.deepEqual(status, {
        version: 1,
        running: 0,
        queued: 0,
        unavailable: { reason: "sign-in" },
        at,
      });
      assert.doesNotMatch(JSON.stringify(status), new RegExp(other));
    } finally {
      await db.end();
    }
  });
});

describe("agent memory on the account's home bay", () => {
  // The seed handles a memory request for bob, whose home is the attached
  // bay: it must run there, over the real fabric, with real encryption.
  const fromSeed = (kind, request, extra = {}) =>
    runInBay(
      cluster,
      SEED,
      `const { withMemoryHome } = server("agents/memory-home.js");
       return await withMemoryHome(${JSON.stringify(bob.account_id)}, {
         kind: ${JSON.stringify(kind)},
         ${extra.project_id ? `project_id: ${JSON.stringify(extra.project_id)},` : ""}
         request: ${JSON.stringify(request)},
       });`,
    );
  const rowsIn = (bay, table) =>
    runInBay(
      cluster,
      bay,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT * FROM ${table} WHERE account_id=$1",
         [${JSON.stringify(bob.account_id)}]);
       return rows;`,
    );

  it("settings and notes written through the seed are stored on bob's home bay", async () => {
    assert.ok(bob.project, "bob's project from routing by ownership");
    await fromSeed("owner", { op: "set-enabled", enabled: true });
    await fromSeed("owner", {
      op: "namespace-save",
      name: "multibay",
      description: "Two-bay test notes",
    });
    await fromSeed("owner", {
      op: "set-project-namespaces",
      project_id: bob.project,
      namespaces: ["multibay"],
    });
    const saved = await fromSeed(
      "agent",
      {
        action: "memory",
        op: "write",
        name: "crossing",
        description: "Saved through the seed",
        body: "This text must be stored encrypted.",
      },
      { project_id: bob.project },
    );
    const { revision, ...rest } = saved;
    assert.deepEqual(rest, {
      name: "multibay/crossing",
      namespace: "multibay",
      saved: "created",
    });
    assert.match(revision, /^[0-9a-f]{16}$/);
    const notes = await rowsIn(ATTACHED, "agent_memory_notes");
    assert.equal(notes.length, 1);
    assert.equal(notes[0].namespace, "multibay");
    assert.ok(!notes[0].body.includes("stored encrypted"));
    assert.equal((await rowsIn(ATTACHED, "agent_memory_accounts")).length, 1);
    assert.equal((await rowsIn(SEED, "agent_memory_notes")).length, 0);
    assert.equal((await rowsIn(SEED, "agent_memory_accounts")).length, 0);
  });

  it("the turn index and search come back across the bays", async () => {
    const index = await fromSeed("turn-index", undefined, {
      project_id: bob.project,
    });
    assert.equal(index.notes, 1);
    assert.match(index.index, /- multibay: Two-bay test notes/);
    assert.match(index.index, /- multibay\/crossing: Saved through the seed/);
    const found = await fromSeed(
      "agent",
      { action: "memory", op: "search", query: "encrypted" },
      { project_id: bob.project },
    );
    assert.deepEqual(
      found.results.map((r) => r.name),
      ["multibay/crossing"],
    );
    // Another of bob's projects does not see the namespace.
    const elsewhere = await fromSeed(
      "agent",
      { action: "memory", op: "list" },
      { project_id: alice.project },
    );
    assert.deepEqual(elsewhere.notes, []);
  });
});

describe("cross-bay collaboration", () => {
  it("lists a seed-owned project for a collaborator homed on the attached bay", async () => {
    await invite(alice, bob, alice.project);
    await eventually(() => listed(bob.client, alice.project), {
      what: "alice's project in bob's list",
    });
  });

  it("propagates the owner's rename to the other bay", async () => {
    await assertCrossBayRename(
      alice.client,
      bob.client,
      alice.project,
      "alice-project renamed",
    );
  });

  it("removes the project from the removed collaborator's list", async () => {
    await alice.client.call("projects.removeCollaborator", {
      opts: { project_id: alice.project, account_id: bob.account_id },
    });
    await eventually(async () => !(await listed(bob.client, alice.project)), {
      what: "alice's project to leave bob's list",
    });
  });

  it("works the other way: an attached-bay project with a seed collaborator", async () => {
    await invite(bob, alice, bob.project);
    await eventually(() => listed(alice.client, bob.project), {
      what: "bob's project in alice's list",
    });
    await assertCrossBayRename(
      bob.client,
      alice.client,
      bob.project,
      "bob-project renamed",
    );
  });
});

describe("a project managed from the other bay", () => {
  // Every call below is made by an account homed on the bay that does NOT
  // own the project, so each one crosses the fabric to the owner.
  let project;

  it("lets a collaborator on the other bay rename it", async () => {
    project = await createProject(alice.client, "shared");
    await invite(alice, bob, project);
    await eventually(() => listed(bob.client, project), {
      what: "the shared project in bob's list",
    });
    await rename(bob.client, project, "renamed by bob");
    for (const c of [alice.client, bob.client]) {
      await eventually(
        async () => (await listed(c, project))?.title === "renamed by bob",
        { what: "bob's rename in every list" },
      );
    }
  });

  it("transfers ownership to an account on the other bay", async () => {
    await alice.client.call("projects.transferProjectOwnership", {
      project_id: project,
      from_account_id: alice.account_id,
      to_account_id: bob.account_id,
    });
    await eventually(
      async () =>
        (await listed(bob.client, project))?.users_summary?.[bob.account_id]
          ?.group === "owner",
      { what: "bob to be the owner in his list" },
    );
    // Ownership moves; the project stays on its owning bay.
    assert.equal(await owningBay(project), SEED);
  });

  it("lets the new owner on the other bay protect it from deletion", async () => {
    const result = await bob.client.call(
      "projects.setProjectDeletionProtection",
      {
        project_id: project,
        enabled: true,
      },
    );
    assert.equal(result.deletion_protection, true);
    await eventually(
      async () => (await listed(alice.client, project))?.deletion_protection,
      { what: "deletion protection in alice's list" },
    );
  });

  it("lets the new owner on the other bay lift deletion protection (fresh auth)", async () => {
    // Lifting protection needs a freshly authenticated session, which lives on
    // the caller's home bay, not on the bay that owns the project.
    const result = await bob.client.call(
      "projects.setProjectDeletionProtection",
      {
        project_id: project,
        enabled: false,
      },
    );
    assert.equal(result.deletion_protection, false);
  });

  it("lets the new owner on the other bay change a member's role", async () => {
    await bob.client.call("projects.setProjectUserRole", {
      opts: {
        project_id: project,
        target_account_id: alice.account_id,
        role: "viewer",
      },
    });
    await eventually(
      async () =>
        (await listed(alice.client, project))?.users_summary?.[alice.account_id]
          ?.group === "viewer",
      { what: "alice to be a viewer in her list" },
    );
  });

  it("lets the new owner on the other bay restrict member management", async () => {
    await bob.client.call("projects.setProjectManageUsersOwnerOnly", {
      project_id: project,
      manage_users_owner_only: true,
    });
    const owner = await runInBay(
      cluster,
      SEED,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT manage_users_owner_only FROM projects WHERE project_id=$1",
         [${JSON.stringify(project)}]);
       return rows[0]?.manage_users_owner_only ?? null;`,
    );
    assert.equal(owner, true);
  });

  it("does not let a viewer on the other bay rename it", async () => {
    await assert.rejects(rename(alice.client, project, "viewer rename"));
    assert.equal((await listed(bob.client, project))?.title, "renamed by bob");
  });

  it("lets the new owner on the other bay transfer ownership back", async () => {
    // A transfer runs on the project's bay, which records each call
    // forwarded to it; fresh auth and admin status come from bob's home bay.
    const forwardedTransfers = async () =>
      await runInBay(
        cluster,
        SEED,
        `const getPool = require("@cocalc/database/pool").default;
         const { rows } = await getPool().query(
           "SELECT COUNT(*)::INT AS n FROM hub_api_forwarded_calls WHERE name='projects.transferProjectOwnership' AND source_bay_id=$1 AND account_id=$2 AND finished IS NOT NULL",
           [${JSON.stringify(ATTACHED)}, ${JSON.stringify(bob.account_id)}]);
         return rows[0].n;`,
      );
    await bob.client.call("projects.setProjectUserRole", {
      opts: {
        project_id: project,
        target_account_id: alice.account_id,
        role: "collaborator",
      },
    });
    const before = await forwardedTransfers();
    await bob.client.call("projects.transferProjectOwnership", {
      project_id: project,
      from_account_id: bob.account_id,
      to_account_id: alice.account_id,
    });
    assert.equal(await forwardedTransfers(), before + 1);
    await eventually(
      async () =>
        (await listed(alice.client, project))?.users_summary?.[alice.account_id]
          ?.group === "owner",
      { what: "alice to be the owner again in her list" },
    );
  });
});

describe("project secrets across bays", () => {
  // bob's project lives on the attached bay; alice (a collaborator) is homed
  // on the seed, so every call below crosses bays.
  const NAME = "MULTIBAY_TOKEN";
  const names = async (c) =>
    (
      await c.call("projects.listProjectSecrets", { project_id: bob.project })
    ).map((secret) => secret.name);

  it("lets a collaborator on the other bay set and list a secret", async () => {
    const set = await alice.client.call("projects.setProjectSecret", {
      project_id: bob.project,
      name: NAME,
      value: "s3cr3t",
    });
    assert.equal(set.name, NAME);
    assert.ok((await names(alice.client)).includes(NAME));
    assert.ok((await names(bob.client)).includes(NAME));
    const refresh = await alice.client.call(
      "projects.refreshProjectSecretsRuntime",
      { project_id: bob.project },
    );
    assert.ok(refresh?.status);
  });

  it("refuses a non-member on the other bay", async () => {
    const gina = await createAccount(cluster, {
      home_bay_id: SEED,
      name: "gina",
    });
    gina.client = await client(gina);
    await assert.rejects(names(gina.client));
    await assert.rejects(
      gina.client.call("projects.setProjectSecret", {
        project_id: bob.project,
        name: NAME,
        value: "nope",
      }),
    );
    await assert.rejects(
      gina.client.call("projects.deleteProjectSecret", {
        project_id: bob.project,
        name: NAME,
      }),
    );
    assert.ok((await names(bob.client)).includes(NAME));
  });

  it("lets a collaborator on the other bay delete a secret", async () => {
    const { deleted } = await alice.client.call(
      "projects.deleteProjectSecret",
      {
        project_id: bob.project,
        name: NAME,
      },
    );
    assert.equal(deleted, true);
    assert.ok(!(await names(bob.client)).includes(NAME));
  });
});

describe("course secrets across bays", () => {
  // bob's project, on the attached bay, acts as the course project; alice, a
  // collaborator homed on the seed, manages its course secret policy.
  const NAME = "COURSE_TOKEN";
  const course = {
    course_id: "c0c0c0c0-0000-4000-8000-00000000c0c0",
    course_path: "multibay.course",
  };

  it("lets a collaborator on the other bay share a secret with the course", async () => {
    await alice.client.call("projects.setProjectSecret", {
      project_id: bob.project,
      name: NAME,
      value: "for-students",
    });
    await alice.client.call("projects.setProjectSecretCourseSharing", {
      project_id: bob.project,
      name: NAME,
      allow: true,
    });
    const shareable = await alice.client.call(
      "projects.listCourseShareableSecrets",
      { course_project_id: bob.project },
    );
    assert.ok(shareable.some((secret) => secret.name === NAME));
  });

  it("lets a collaborator on the other bay enable and revoke the course policy", async () => {
    await alice.client.call("projects.setCourseSecretPolicy", {
      course_project_id: bob.project,
      ...course,
      enabled: true,
    });
    const policy = await alice.client.call("projects.getCourseSecretPolicy", {
      course_project_id: bob.project,
      ...course,
    });
    assert.equal(policy?.policy?.enabled, true);
    await alice.client.call("projects.revokeCourseSecretPolicy", {
      course_project_id: bob.project,
      ...course,
    });
  });
});

describe("project control across bays", () => {
  // bob's project lives on the attached bay; alice, a collaborator homed on
  // the seed, reads its state there. (Stopping needs a project host, which
  // this cluster does not have.)
  it("reads the project's state and active operation on its bay", async () => {
    const state = await alice.client.call("projects.getProjectState", {
      project_id: bob.project,
    });
    assert.ok(state && typeof state === "object", JSON.stringify(state));
    const op = await alice.client.call("projects.getProjectActiveOperation", {
      project_id: bob.project,
    });
    assert.ok(op === null || op?.project_id === bob.project);
  });
});

describe("document history across bays", () => {
  // bob's project lives on the attached bay; alice, a collaborator homed on
  // the seed, reads and purges a document's edit history (TimeTravel), which
  // lives with the project.
  const path = "history.txt";

  it("reads and purges the history on the project's bay", async () => {
    await runInBay(
      cluster,
      ATTACHED,
      `const { conat } = require("@cocalc/backend/conat");
       const { patchesStreamName } = require("@cocalc/conat/sync/synctable-stream");
       const stream = conat().sync.astream({
         project_id: ${JSON.stringify(bob.project)},
         name: patchesStreamName({ path: ${JSON.stringify(path)} }),
         noInventory: true,
       });
       for (let i = 0; i < 3; i++) {
         const time = Date.now() + i;
         await stream.publish({ time, wall: time, patch: "[]", user_id: 0, parents: [] });
       }
       stream.close();`,
    );
    const history = await alice.client.call("sync.history", {
      project_id: bob.project,
      path,
    });
    assert.equal(history.patches.length, 3);
    const result = await alice.client.call("sync.purgeHistory", {
      project_id: bob.project,
      path,
    });
    assert.deepEqual(result, { deleted: 3, history_epoch: 1, reset: true });
    const purged = await alice.client.call("sync.history", {
      project_id: bob.project,
      path,
    });
    assert.equal(purged.patches.length, 0);
  });

  it("refuses a non-member on the other bay", async () => {
    const hana = await createAccount(cluster, {
      home_bay_id: SEED,
      name: "hana",
    });
    hana.client = await client(hana);
    await assert.rejects(
      hana.client.call("sync.history", { project_id: bob.project, path }),
    );
    await assert.rejects(
      hana.client.call("sync.purgeHistory", { project_id: bob.project, path }),
    );
  });
});

describe("edit history storage across bays", () => {
  // bob's project lives on the attached bay; alice, a collaborator homed on
  // the seed, lists and manages the edit history and logs it stores. Both
  // run on the project's bay, which records each forwarded call. (This
  // cluster's workspace runtime keeps the history with the project's files,
  // so the list is unsupported and a change is refused, after the checks of
  // who asks.)
  const LIST = "projects.listProjectPersistStorage";
  const APPLY = "projects.applyProjectPersistStorage";
  const forwardedCalls = async (name) =>
    await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT COUNT(*)::INT AS n FROM hub_api_forwarded_calls WHERE name=$1 AND source_bay_id=$2 AND account_id=$3 AND finished IS NOT NULL",
         [${JSON.stringify(name)}, ${JSON.stringify(SEED)}, ${JSON.stringify(alice.account_id)}]);
       return rows[0].n;`,
    );
  // the owner's switch (Settings: Storage history)
  const allowCollaborators = async (allow) =>
    await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       await getPool().query(
         "UPDATE projects SET allow_collaborator_destructive_storage_actions=$1 WHERE project_id=$2",
         [${JSON.stringify(allow)}, ${JSON.stringify(bob.project)}]);`,
    );

  it("lists on the project's bay, saying who may manage it", async () => {
    assert.ok(bob.project, "needs bob's project");
    const before = await forwardedCalls(LIST);
    const list = await alice.client.call(LIST, { project_id: bob.project });
    assert.equal(list.supported, false);
    assert.equal(list.can_manage, false);
    assert.equal(await forwardedCalls(LIST), before + 1);
    const owners = await bob.client.call(LIST, { project_id: bob.project });
    assert.equal(owners.can_manage, true);
  });

  it("lets a collaborator on the other bay manage it only if the owner allows", async () => {
    await assert.rejects(
      alice.client.call(APPLY, {
        project_id: bob.project,
        actions: [{ op: "delete", name: "patchflow/home/user/a.md" }],
      }),
      /Only project owners can delete or trim edit history and logs/,
    );
    await allowCollaborators(true);
    try {
      const list = await alice.client.call(LIST, { project_id: bob.project });
      assert.equal(list.can_manage, true);
      const before = await forwardedCalls(APPLY);
      assert.deepEqual(
        await alice.client.call(APPLY, {
          project_id: bob.project,
          actions: [],
        }),
        { results: [], freed: 0 },
      );
      assert.equal(await forwardedCalls(APPLY), before + 1);
      await assert.rejects(
        alice.client.call(APPLY, {
          project_id: bob.project,
          actions: [
            {
              op: "delete",
              name: "patchflow/home/user/a.md",
              ifDocumentMissing: true,
            },
          ],
        }),
        /trusted workspace keeps its edit history with its files/,
      );
    } finally {
      await allowCollaborators(false);
    }
  });

  it("refuses a non-member on the other bay", async () => {
    const ines = await createAccount(cluster, {
      home_bay_id: SEED,
      name: "ines",
    });
    ines.client = await client(ines);
    await assert.rejects(ines.client.call(LIST, { project_id: bob.project }));
    await assert.rejects(
      ines.client.call(APPLY, { project_id: bob.project, actions: [] }),
    );
  });
});

describe("project moves across bays", () => {
  // bob's project lives on the attached bay; alice, a collaborator homed on
  // the seed, asks to move it or place it on a host. Both are routed to the
  // project's bay, which records each forwarded call it runs. (This
  // cluster's workspace runtime supports neither, so the method's answer is
  // that refusal.)
  const forwardedCalls = async (name) =>
    await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT COUNT(*)::INT AS n FROM hub_api_forwarded_calls WHERE name=$1 AND source_bay_id=$2 AND account_id=$3 AND finished IS NOT NULL",
         [${JSON.stringify(name)}, ${JSON.stringify(SEED)}, ${JSON.stringify(alice.account_id)}]);
       return rows[0].n;`,
    );
  for (const [name, args, capability] of [
    ["projects.moveProject", {}, "move"],
    [
      "projects.assignProjectHost",
      { dest_host_id: randomUUID() },
      "host placement",
    ],
  ]) {
    it(`${name} runs on the project's bay`, async () => {
      assert.ok(bob.project, "needs bob's project");
      const before = await forwardedCalls(name);
      await assert.rejects(
        alice.client.call(name, { project_id: bob.project, ...args }),
        new RegExp(
          `${capability} is unsupported by the trusted workspace runtime`,
        ),
      );
      assert.equal(await forwardedCalls(name), before + 1);
    });
  }
});

describe("hiding projects across bays", () => {
  // alice, homed on the seed, hides her own project (on the seed) and bob's
  // (on the attached bay, where she is a collaborator) in one call. The call
  // runs once per bay with that bay's projects; the attached bay records the
  // part forwarded to it. Each bay keeps the flag in its own project row.
  const hiddenOn = async (bay, project_id) =>
    await runInBay(
      cluster,
      bay,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT users -> $2::text ->> 'hide' AS hide FROM projects WHERE project_id=$1",
         [${JSON.stringify(project_id)}, ${JSON.stringify(alice.account_id)}]);
       return rows[0]?.hide ?? null;`,
    );
  const forwardedHides = async () =>
    await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT COUNT(*)::INT AS n FROM hub_api_forwarded_calls WHERE name='projects.setProjectsHidden' AND source_bay_id=$1 AND account_id=$2 AND finished IS NOT NULL",
         [${JSON.stringify(SEED)}, ${JSON.stringify(alice.account_id)}]);
       return rows[0].n;`,
    );
  const setHidden = async (hide) =>
    await alice.client.call("projects.setProjectsHidden", {
      project_ids: [bob.project, alice.project],
      hide,
    });

  it("hides a project on each bay, each on its own bay", async () => {
    assert.ok(alice.project && bob.project, "needs both projects");
    const before = await forwardedHides();
    assert.deepEqual(await setHidden(true), [
      { project_id: bob.project, success: true },
      { project_id: alice.project, success: true },
    ]);
    assert.equal(await forwardedHides(), before + 1);
    assert.equal(await hiddenOn(ATTACHED, bob.project), "true");
    assert.equal(await hiddenOn(SEED, alice.project), "true");
  });

  it("unhides them the same way", async () => {
    assert.deepEqual(await setHidden(false), [
      { project_id: bob.project, success: true },
      { project_id: alice.project, success: true },
    ]);
    assert.equal(await hiddenOn(ATTACHED, bob.project), "false");
    assert.equal(await hiddenOn(SEED, alice.project), "false");
  });
});

describe("leaving projects across bays", () => {
  // leaver, homed on the seed, collaborates on a project on each bay and
  // leaves both in one call. The call runs once per bay with that bay's
  // project; the attached bay records the part forwarded to it, after asking
  // the seed (leaver's home) for fresh auth. Own accounts: projects count
  // against each account's limit.
  let leaver;
  const member = async (bay, project_id) =>
    await runInBay(
      cluster,
      bay,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT users -> $2::text ->> 'group' AS grp FROM projects WHERE project_id=$1",
         [${JSON.stringify(project_id)}, ${JSON.stringify(leaver.account_id)}]);
       return rows[0]?.grp ?? null;`,
    );
  const forwardedLeaves = async () =>
    await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT COUNT(*)::INT AS n FROM hub_api_forwarded_calls WHERE name='projects.leaveOrDeleteProjects' AND source_bay_id=$1 AND account_id=$2 AND finished IS NOT NULL",
         [${JSON.stringify(SEED)}, ${JSON.stringify(leaver.account_id)}]);
       return rows[0].n;`,
    );

  it("leaves a project on each bay, each on its own bay", async () => {
    leaver = await createAccount(cluster, {
      home_bay_id: SEED,
      name: "leaver",
    });
    leaver.client = await client(leaver);
    const seedOwner = await createAccount(cluster, {
      home_bay_id: SEED,
      name: "seed-owner",
    });
    seedOwner.client = await client(seedOwner);
    const attachedOwner = await createAccount(cluster, {
      home_bay_id: ATTACHED,
      name: "attached-owner",
    });
    attachedOwner.client = await client(attachedOwner);
    const local = await createProject(seedOwner.client, "leave-seed");
    const remote = await createProject(attachedOwner.client, "leave-attached");
    await invite(seedOwner, leaver, local);
    await invite(attachedOwner, leaver, remote);
    assert.equal(await owningBay(remote), ATTACHED);
    assert.equal(await member(ATTACHED, remote), "collaborator");
    assert.equal(await member(SEED, local), "collaborator");

    const before = await forwardedLeaves();
    assert.deepEqual(
      await leaver.client.call("projects.leaveOrDeleteProjects", {
        project_ids: [local, remote],
      }),
      [
        { project_id: local, action: "removed_self" },
        { project_id: remote, action: "removed_self" },
      ],
    );
    assert.equal(await forwardedLeaves(), before + 1);
    assert.equal(await member(ATTACHED, remote), null);
    assert.equal(await member(SEED, local), null);
  });
});

describe("bulk project stop across bays", () => {
  // carol, homed on the seed, stops a project on each bay in one call. Each
  // project's stop is its own call, forwarded to the project's bay when it is
  // not this one; that bay records each forwarded call it runs. This cluster
  // has no project hosts, so the stops themselves do not finish here: the
  // test checks only where each one runs, with accounts and projects of its
  // own (the hung stops then affect nothing else).
  let carol;
  let dave;
  const forwardedStops = async () =>
    await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT COUNT(*)::INT AS n FROM hub_api_forwarded_calls WHERE name='projects.stop' AND source_bay_id=$1 AND account_id=$2",
         [${JSON.stringify(SEED)}, ${JSON.stringify(carol.account_id)}]);
       return rows[0].n;`,
    );

  it("sends the other bay's project's stop to that bay", async () => {
    carol = await createAccount(cluster, {
      home_bay_id: SEED,
      name: "bulk-stopper",
    });
    carol.client = await client(carol);
    dave = await createAccount(cluster, {
      home_bay_id: ATTACHED,
      name: "bulk-owner",
    });
    dave.client = await client(dave);
    const local = await createProject(carol.client, "bulk-stop-seed");
    const remote = await createProject(dave.client, "bulk-stop-attached");
    await invite(dave, carol, remote);
    assert.equal(await owningBay(local), SEED);
    assert.equal(await owningBay(remote), ATTACHED);
    const before = await forwardedStops();
    const pending = carol.client
      .call("projects.stopProjects", { project_ids: [local, remote] })
      .catch(() => undefined);
    await eventually(async () => (await forwardedStops()) === before + 1, {
      what: "the attached bay to run the forwarded stop",
    });
    // Only the attached bay's project was forwarded.
    await sleep(2000);
    assert.equal(await forwardedStops(), before + 1);
    void pending;
  });
});

describe("host reads across bays", () => {
  // A host on the attached bay, owned by alice (homed on the seed): reading
  // its log runs on the host's bay, which records the forwarded call.
  const host_id = randomUUID();
  let startOp; // the start queued below, on the host's bay
  const forwardedReads = async () =>
    await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       const t = await getPool().query("SELECT to_regclass('hub_api_forwarded_calls') AS t");
       if (t.rows[0].t == null) return 0; // nothing forwarded to this bay yet
       const { rows } = await getPool().query(
         "SELECT COUNT(*)::INT AS n FROM hub_api_forwarded_calls WHERE name='hosts.getHostLog' AND source_bay_id=$1 AND account_id=$2 AND finished IS NOT NULL",
         [${JSON.stringify(SEED)}, ${JSON.stringify(alice.account_id)}]);
       return rows[0].n;`,
    );

  it("reads a host's log on the host's bay", async () => {
    await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       await getPool().query(
         "INSERT INTO project_hosts (id, name, status, metadata, created, updated, bay_id) VALUES ($1, 'routed-host', 'off', $2, NOW(), NOW(), $3)",
         [${JSON.stringify(host_id)}, ${JSON.stringify({ owner: alice.account_id })}, ${JSON.stringify(ATTACHED)}]);
       await getPool().query(
         "INSERT INTO cloud_vm_log (id, vm_id, ts, action, status) VALUES ($1, $2, NOW(), 'create', 'success')",
         [${JSON.stringify(randomUUID())}, ${JSON.stringify(host_id)}]);`,
    );
    const before = await forwardedReads();
    const log = await alice.client.call("hosts.getHostLog", { id: host_id });
    assert.deepEqual(
      log.map(({ vm_id, action, status }) => ({ vm_id, action, status })),
      [{ vm_id: host_id, action: "create", status: "success" }],
    );
    assert.equal(await forwardedReads(), before + 1);
  });

  it("waits as long as the caller asked for a slow read", async () => {
    // The log read is held up 26 s on the host's bay: past what the default
    // forwarding budget covers (two 12 s attempts, a repeat waiting 9 s),
    // within the 300 s this call asks for, and within the bay's own 30 s
    // statement timeout. Its 120 s attempts exceed fast RPC's 90 s ack
    // limit, so they go by request/reply.
    const BLOCKED_MS = 26_000;
    const db = await connectBayDatabase(cluster, ATTACHED);
    let released;
    try {
      await db.query("BEGIN");
      await db.query("LOCK TABLE cloud_vm_log IN ACCESS EXCLUSIVE MODE");
      released = sleep(BLOCKED_MS).then(() => db.query("COMMIT"));
      const started = Date.now();
      const log = await alice.client.call("hosts.getHostLog", {
        id: host_id,
        timeout: 300_000,
      });
      assert.ok(Date.now() - started > 22_000, "the read was held up");
      assert.deepEqual(
        log.map(({ vm_id, action }) => ({ vm_id, action })),
        [{ vm_id: host_id, action: "create" }],
      );
    } finally {
      await released?.catch(() => undefined);
      await db.end();
    }
  });

  it("changes a host's access on the host's bay, with fresh auth from home", async () => {
    // Granting manager access needs fresh auth: the host's bay asks alice's
    // home bay (the seed) to vouch for her session. Removing access also
    // needs a second factor, which alice has not enrolled: the host's bay
    // refuses, and the caller gets its reason.
    const forwarded = async (name) =>
      await runInBay(
        cluster,
        ATTACHED,
        `const getPool = require("@cocalc/database/pool").default;
         const { rows } = await getPool().query(
           "SELECT COUNT(*)::INT AS n FROM hub_api_forwarded_calls WHERE name=$1 AND source_bay_id=$2 AND account_id=$3 AND finished IS NOT NULL",
           [${JSON.stringify(name)}, ${JSON.stringify(SEED)}, ${JSON.stringify(alice.account_id)}]);
         return rows[0].n;`,
      );
    const bobsRoles = async () =>
      (await alice.client.call("hosts.listHostAccess", { id: host_id }))
        .filter((entry) => entry.account_id === bob.account_id)
        .map(({ role }) => role);
    const grant = async (role) =>
      await alice.client.call("hosts.setHostAccess", {
        id: host_id,
        target_account_id: bob.account_id,
        role,
      });

    const setBefore = await forwarded("hosts.setHostAccess");
    assert.equal((await grant("manager")).role, "manager");
    assert.deepEqual(await bobsRoles(), ["manager"]);
    assert.equal((await grant("user")).role, "user");
    assert.deepEqual(await bobsRoles(), ["user"]);
    assert.equal(await forwarded("hosts.setHostAccess"), setBefore + 2);

    const removeBefore = await forwarded("hosts.removeHostAccess");
    await assert.rejects(
      alice.client.call("hosts.removeHostAccess", {
        id: host_id,
        target_account_id: bob.account_id,
      }),
      (err) => err.code === "two_factor_required",
    );
    assert.equal(await forwarded("hosts.removeHostAccess"), removeBefore + 1);
    assert.deepEqual(await bobsRoles(), ["user"]);
  });

  it("sets a host's runtime deployments on the host's bay", async () => {
    // Host-scoped: routed to the host's bay, which records it, and the
    // listing (also routed) reads it back there.
    const forwarded = async () =>
      await runInBay(
        cluster,
        ATTACHED,
        `const getPool = require("@cocalc/database/pool").default;
         const { rows } = await getPool().query(
           "SELECT COUNT(*)::INT AS n FROM hub_api_forwarded_calls WHERE name='hosts.setHostRuntimeDeployments' AND source_bay_id=$1 AND account_id=$2 AND finished IS NOT NULL",
           [${JSON.stringify(SEED)}, ${JSON.stringify(alice.account_id)}]);
         return rows[0].n;`,
      );
    const before = await forwarded();
    const set = await alice.client.call("hosts.setHostRuntimeDeployments", {
      scope_type: "host",
      id: host_id,
      deployments: [
        {
          target_type: "artifact",
          target: "project-host",
          desired_version: "ph-routed",
        },
      ],
      replace: true,
    });
    assert.ok(
      set.some(
        (d) => d.host_id === host_id && d.desired_version === "ph-routed",
      ),
    );
    assert.equal(await forwarded(), before + 1);
    const listed = await alice.client.call("hosts.listHostRuntimeDeployments", {
      scope_type: "host",
      id: host_id,
    });
    assert.ok(
      listed.some(
        (d) => d.target === "project-host" && d.desired_version === "ph-routed",
      ),
    );
  });

  it("lists and stops a host's projects on the host's bay", async () => {
    // The host's projects are listed where the host lives; the bulk stop
    // (fresh auth from alice's home bay) queues its operation there too.
    const forwarded = async (name) =>
      await runInBay(
        cluster,
        ATTACHED,
        `const getPool = require("@cocalc/database/pool").default;
         const { rows } = await getPool().query(
           "SELECT COUNT(*)::INT AS n FROM hub_api_forwarded_calls WHERE name=$1 AND source_bay_id=$2 AND account_id=$3 AND finished IS NOT NULL",
           [${JSON.stringify(name)}, ${JSON.stringify(SEED)}, ${JSON.stringify(alice.account_id)}]);
         return rows[0].n;`,
      );
    const listBefore = await forwarded("hosts.listHostProjects");
    const listed = await alice.client.call("hosts.listHostProjects", {
      id: host_id,
    });
    assert.deepEqual(listed.rows, []);
    assert.equal(listed.summary?.total, 0);
    assert.equal(await forwarded("hosts.listHostProjects"), listBefore + 1);

    const stopBefore = await forwarded("hosts.stopHostProjects");
    const op = await alice.client.call("hosts.stopHostProjects", {
      id: host_id,
      state_filter: "running",
    });
    assert.ok(op?.op_id, "a stop operation was queued");
    assert.equal(await forwarded("hosts.stopHostProjects"), stopBefore + 1);
    const kind = await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT kind FROM long_running_operations WHERE op_id=$1",
         [${JSON.stringify(op.op_id)}]);
       return rows[0]?.kind ?? null;`,
    );
    assert.equal(kind, "host-stop-projects");
  });

  it("queues a host start on the host's bay", async () => {
    // Last in this group: the start itself then fails (this host has no
    // cloud provider), so only where it is queued is checked.
    const forwarded = async () =>
      await runInBay(
        cluster,
        ATTACHED,
        `const getPool = require("@cocalc/database/pool").default;
         const { rows } = await getPool().query(
           "SELECT COUNT(*)::INT AS n FROM hub_api_forwarded_calls WHERE name='hosts.startHost' AND source_bay_id=$1 AND account_id=$2 AND finished IS NOT NULL",
           [${JSON.stringify(SEED)}, ${JSON.stringify(alice.account_id)}]);
         return rows[0].n;`,
      );
    const before = await forwarded();
    const op = await alice.client.call("hosts.startHost", { id: host_id });
    assert.ok(op?.op_id, "a start operation was queued");
    startOp = op;
    assert.equal(await forwarded(), before + 1);
    const queuedOn = await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT COUNT(*)::INT AS n FROM long_running_operations WHERE op_id=$1",
         [${JSON.stringify(op.op_id)}]);
       return rows[0].n;`,
    );
    assert.equal(queuedOn, 1, "the operation is recorded on the host's bay");
  });

  it("stops a host as the system, from another bay, with no session", async () => {
    // Trusted server code (quarantine) stops hosts with no user session: the
    // seed sends the allow-listed system action to the host's bay.
    const forwarded = async () =>
      await runInBay(
        cluster,
        ATTACHED,
        `const getPool = require("@cocalc/database/pool").default;
         const { rows } = await getPool().query(
           "SELECT COUNT(*)::INT AS n FROM hub_api_forwarded_calls WHERE name='hosts.stopHost' AND source_bay_id=$1 AND finished IS NOT NULL",
           [${JSON.stringify(SEED)}]);
         return rows[0].n;`,
      );
    const before = await forwarded();
    const op = await runInBay(
      cluster,
      SEED,
      `const { runHostActionAsSystem } = server("conat/api/system-host-actions.js");
       return await runHostActionAsSystem("hosts.stopHost", {
         account_id: ${JSON.stringify(alice.account_id)},
         id: ${JSON.stringify(host_id)},
       });`,
    );
    assert.ok(op?.op_id, "a stop operation was queued");
    assert.equal(await forwarded(), before + 1);
    const queuedOn = await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT kind FROM long_running_operations WHERE op_id=$1",
         [${JSON.stringify(op.op_id)}]);
       return rows[0]?.kind ?? null;`,
    );
    assert.equal(queuedOn, "host-stop");
  });

  it("reads and waits for a host's operation on the host's bay", async () => {
    // The fleet rollout queues operations on hosts of any bay and waits for
    // them: their summaries are read on the host's bay (lro.get and lro.list
    // naming the host are routed there).
    assert.ok(startOp, "needs the start queued above");
    const scope = { scope_type: "host", scope_id: host_id };
    const read = await alice.client.call("lro.get", {
      op_id: startOp.op_id,
      ...scope,
    });
    assert.equal(read?.op_id, startOp.op_id);
    // Not named, the scope is unknown: the seed has no such operation.
    assert.equal(
      (await alice.client.call("lro.get", { op_id: startOp.op_id })) ?? null,
      null,
    );
    const listed = await alice.client.call("lro.list", {
      ...scope,
      include_completed: true,
    });
    assert.ok(listed.some(({ op_id }) => op_id === startOp.op_id));
    // A wait from the seed sees it finish (or be canceled by the stop above:
    // this host has no cloud provider, so it cannot succeed).
    const done = await runInBay(
      cluster,
      SEED,
      `const { conat } = require("@cocalc/backend/conat");
       const { waitForHostLro } = server("conat/api/hosts-routed.js");
       const summary = await waitForHostLro({
         account_id: ${JSON.stringify(alice.account_id)},
         op: ${JSON.stringify({ op_id: startOp.op_id, scope_type: "host", scope_id: host_id })},
         client: conat(),
         timeout_ms: 90_000,
       });
       return { op_id: summary.op_id, status: summary.status };`,
      { timeoutMs: 120_000 },
    );
    assert.equal(done.op_id, startOp.op_id);
    assert.ok(
      ["succeeded", "failed", "canceled", "expired"].includes(done.status),
      JSON.stringify(done),
    );
  });

  it("cancels and dismisses a host's operation on the host's bay", async () => {
    // The hosts page names the host when it cancels: lro.cancel and
    // lro.dismiss are then routed to the host's bay, which keeps the
    // operation. A kind no worker claims stays queued until canceled.
    const op_id = await runInBay(
      cluster,
      ATTACHED,
      `const { createLro } = server("lro/lro-db.js");
       const op = await createLro({
         kind: "multibay-test-idle",
         scope_type: "host",
         scope_id: ${JSON.stringify(host_id)},
         created_by: ${JSON.stringify(alice.account_id)},
       });
       return op.op_id;`,
    );
    const scope = { scope_type: "host", scope_id: host_id };
    await alice.client.call("lro.cancel", { op_id, ...scope });
    const canceled = await alice.client.call("lro.get", { op_id, ...scope });
    assert.equal(canceled?.status, "canceled");
    await alice.client.call("lro.dismiss", { op_id, ...scope });
    const dismissed = await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT dismissed_at IS NOT NULL AS dismissed FROM long_running_operations WHERE op_id=$1",
         [${JSON.stringify(op_id)}]);
       return rows[0]?.dismissed ?? null;`,
    );
    assert.equal(dismissed, true, "dismissed on the host's bay");
  });
});

describe("course reconfiguration across bays", () => {
  // bob's project, on the attached bay, is the course; alice, a collaborator
  // homed on the seed, reconfigures it. The operation lives on the course
  // project's owning bay, where bob reads and cancels it.
  let op_id;

  it("runs a reconfiguration on the course project's bay", async () => {
    const op = await alice.client.call("projects.reconfigureCourseProjects", {
      course_project_id: bob.project,
      course_path: "multibay.course",
      settings: {
        title: "Multibay course",
        description: "",
        allow_collabs: false,
        datastore: true,
        invite: {
          subject: "Course invitation",
          message: "Please join",
          email_html: "<p>Please join</p>",
        },
      },
      students: [],
    });
    op_id = op.op_id;
    assert.ok(op_id, "a reconfiguration operation");
    const seen = await bob.client.call(
      "projects.getCourseReconfigureOperation",
      { course_project_id: bob.project, op_id },
    );
    assert.equal(seen?.scope_id, bob.project);
  });

  it("lets a collaborator on the other bay read and cancel it", async () => {
    await bob.client.call("projects.cancelCourseReconfigureOperation", {
      course_project_id: bob.project,
      op_id,
    });
    const seen = await alice.client.call(
      "projects.getCourseReconfigureOperation",
      { course_project_id: bob.project, op_id },
    );
    assert.ok(
      ["canceled", "succeeded"].includes(seen?.status),
      `status ${seen?.status}`,
    );
  });
});

describe("course manager access across bays", () => {
  // bob's project, on the attached bay, is the course; alice, a collaborator
  // homed on the seed, asks for the course's managers to be added to a
  // student project on the seed. The call runs on the course's bay, which
  // reads the managers there and vouches for them to the seed (as itself:
  // the seed accepts that only from the course's owning bay).
  let studentProject;
  const forwardedCalls = async (name = "projects.ensureCourseManagerAccess") =>
    await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       const t = await getPool().query("SELECT to_regclass('hub_api_forwarded_calls') AS t");
       if (t.rows[0].t == null) return 0; // nothing forwarded to this bay yet
       const { rows } = await getPool().query(
         "SELECT COUNT(*)::INT AS n FROM hub_api_forwarded_calls WHERE name=$3 AND source_bay_id=$1 AND account_id=$2 AND finished IS NOT NULL",
         [${JSON.stringify(SEED)}, ${JSON.stringify(alice.account_id)}, ${JSON.stringify(name)}]);
       return rows[0].n;`,
    );

  it("adds the course's managers to a student project on the other bay", async () => {
    assert.ok(alice.project && bob.project, "needs both projects");
    const student = await createAccount(cluster, {
      home_bay_id: SEED,
      name: "course-student",
    });
    student.client = await client(student);
    studentProject = await createProject(student.client, "student");
    // Link it to bob's course, as the course tooling does.
    await runInBay(
      cluster,
      SEED,
      `const getPool = require("@cocalc/database/pool").default;
       await getPool().query(
         "UPDATE projects SET course=$2::jsonb WHERE project_id=$1",
         [${JSON.stringify(studentProject)}, JSON.stringify({ project_id: ${JSON.stringify(bob.project)}, type: "student" })]);`,
    );
    const before = await forwardedCalls();
    const [result] = await alice.client.call(
      "projects.ensureCourseManagerAccess",
      { course_project_id: bob.project, project_ids: [studentProject] },
    );
    assert.equal(result.project_id, studentProject);
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.ok(result.added_account_ids.includes(bob.account_id));
    assert.equal(await forwardedCalls(), before + 1);
    const group = await runInBay(
      cluster,
      SEED,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT users -> $2::text ->> 'group' AS grp FROM projects WHERE project_id=$1",
         [${JSON.stringify(studentProject)}, ${JSON.stringify(bob.account_id)}]);
       return rows[0]?.grp ?? null;`,
    );
    assert.equal(group, "collaborator");
  });

  it("sends an assignment patch from the course project's bay", async () => {
    assert.ok(studentProject, "needs the student project");
    const name = "projects.sendCourseAssignmentPatch";
    const before = await forwardedCalls(name);
    const result = await alice.client.call(name, {
      course_project_id: bob.project,
      assignment_id: "multibay-patch",
      src_base_path: "hw",
      dest_base_path: "hw",
      relative_paths: ["notes.md"],
      dests: [{ student_id: "student-1", student_project_id: studentProject }],
    });
    assert.ok(result?.op_id, JSON.stringify(result));
    assert.equal(await forwardedCalls(name), before + 1);
  });
});

describe("course collections across bays", () => {
  // bob's project, on the attached bay, is the course; alice, a collaborator
  // homed on the seed, schedules a collection of a student project. The
  // collection lives on the course project's owning bay (#1001), so bob, on
  // that bay, sees and cancels it.
  const assignment_id = "multibay-assignment";
  const run_at = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  let op_id;
  let studentProjects;

  const item = (student_project_id, n) => ({
    student_id: `student-${n}`,
    student_project_id,
    src_path: "hw",
    dest_path: `hw-collect/student-${n}`,
  });

  it("schedules a collection on the course project's bay", async () => {
    studentProjects = [
      await createProject(alice.client, "student one"),
      await createProject(alice.client, "student two"),
    ];
    const op = await alice.client.call("projects.collectAssignment", {
      course_project_id: bob.project,
      assignment_id,
      items: [item(studentProjects[0], 1)],
      run_at,
    });
    op_id = op.op_id;
    assert.ok(op_id, "a collection operation");
    const seen = await bob.client.call(
      "projects.getCourseCollectionOperation",
      {
        course_project_id: bob.project,
        op_id,
      },
    );
    assert.equal(seen?.status, "queued");
    assert.equal(seen?.scope_id, bob.project);
  });

  it("adds a later student to the scheduled collection", async () => {
    const added = await alice.client.call(
      "projects.addScheduledCollectionStudents",
      {
        course_project_id: bob.project,
        assignment_id,
        op_id,
        items: [item(studentProjects[1], 2)],
      },
    );
    assert.deepEqual(added, { updated: true, item_count: 2 });
  });

  it("lets a collaborator on the other bay cancel it", async () => {
    const result = await bob.client.call(
      "projects.cancelCourseCollectionOperation",
      { course_project_id: bob.project, op_id },
    );
    assert.deepEqual(result, { found: true });
    const seen = await alice.client.call(
      "projects.getCourseCollectionOperation",
      { course_project_id: bob.project, op_id },
    );
    assert.equal(seen?.status, "canceled");
  });
});

describe("access requests across bays", () => {
  // The project lives on the seed; its owner (bob) and the requesters are
  // homed on either bay, so requests and their management cross bays.
  let project;

  async function request(account) {
    return await account.client.call("projects.requestProjectAccess", {
      project_id: project,
      requested_role: "collaborator",
      message: `from ${account.home_bay_id}`,
      source: "api",
    });
  }

  it("lets an owner on the other bay approve a request", async () => {
    project = await createProject(alice.client, "requests");
    await invite(alice, bob, project);
    await alice.client.call("projects.transferProjectOwnership", {
      project_id: project,
      from_account_id: alice.account_id,
      to_account_id: bob.account_id,
    });
    const erin = await createAccount(cluster, {
      home_bay_id: ATTACHED,
      name: "erin",
    });
    erin.client = await client(erin);
    const { request_id } = await request(erin);
    const pending = await eventually(
      async () =>
        (
          await bob.client.call("projects.listProjectAccessRequests", {
            project_id: project,
            status: "pending",
          })
        ).find((row) => row.request_id === request_id),
      { what: "erin's request in the owner's list" },
    );
    assert.equal(pending.requester_account_id, erin.account_id);
    await bob.client.call("projects.respondProjectAccessRequest", {
      project_id: project,
      request_id,
      action: "approve",
      role: "collaborator",
    });
    await eventually(() => listed(erin.client, project), {
      what: "the project in erin's list",
    });
  });

  it("lets an owner on the other bay block and unblock a requester", async () => {
    const frank = await createAccount(cluster, {
      home_bay_id: SEED,
      name: "frank",
    });
    frank.client = await client(frank);
    const { request_id } = await request(frank);
    await bob.client.call("projects.respondProjectAccessRequest", {
      project_id: project,
      request_id,
      action: "block",
    });
    const blocked = async () =>
      (
        await bob.client.call("projects.listProjectAccessRequestBlocks", {
          project_id: project,
        })
      ).some((row) => row.blocked_account_id === frank.account_id);
    assert.equal(await blocked(), true);
    await assert.rejects(request(frank));
    await bob.client.call("projects.unblockProjectAccessRequester", {
      project_id: project,
      blocked_account_id: frank.account_id,
    });
    assert.equal(await blocked(), false);
  });

  it("reports collaborator invite usage to a member on the other bay", async () => {
    const usage = await bob.client.call(
      "projects.getProjectCollaboratorInviteUsage",
      { project_id: project },
    );
    assert.ok(usage != null && typeof usage === "object");
  });
});

describe("email invites across bays", () => {
  // bob's project lives on the attached bay; alice, a collaborator homed on
  // the seed, invites gina by email. gina is homed on the seed and accepts
  // through the link token alone, so each call is routed to the owning bay.
  let project;
  let gina;
  let token;

  it("lets a collaborator on the other bay invite by email and copy the link", async () => {
    project = await createProject(bob.client, "email invites");
    await invite(bob, alice, project);
    gina = await createAccount(cluster, { home_bay_id: SEED, name: "gina" });
    gina.client = await client(gina);
    const sent = await alice.client.call(
      "projects.inviteCollaboratorWithoutAccount",
      {
        opts: {
          project_id: project,
          title: "email invites",
          link2proj: "",
          to: gina.email_address,
          email: "",
          send_email: false,
          invite_base_url: "https://multibay.test",
        },
      },
    );
    const invite_id = sent.invites[0]?.invite_id;
    assert.ok(invite_id, "an invite was created");
    const { invite_url } = await alice.client.call(
      "projects.copyEmailProjectInviteLink",
      { invite_id, invite_base_url: "https://multibay.test" },
    );
    token = decodeURIComponent(invite_url.split("/invites/")[1] ?? "");
    assert.ok(token, `a token in ${invite_url}`);
    const outbound = await alice.client.call("projects.listCollabInvites", {
      project_id: project,
      status: "pending",
    });
    assert.ok(outbound.some((row) => row.invite_id === invite_id));
  });

  it("lets the invitee preview and accept with only the link token", async () => {
    const preview = await gina.client.call(
      "projects.previewEmailProjectInvite",
      { token },
    );
    assert.equal(preview.project_id, project);
    await gina.client.call("projects.respondEmailProjectInvite", {
      token,
      action: "accept",
    });
    await eventually(() => listed(gina.client, project), {
      what: "the project in gina's list",
    });
  });

  it("lets an invitee open and accept the link through the web pages", async () => {
    // The /invites/<token> page uses HTTP endpoints, not the hub API, so the
    // seed must forward them to the bay that owns the invite.
    const hank = await createAccount(cluster, {
      home_bay_id: SEED,
      name: "hank",
    });
    hank.client = await client(hank);
    const sent = await alice.client.call(
      "projects.inviteCollaboratorWithoutAccount",
      {
        opts: {
          project_id: project,
          title: "email invites",
          link2proj: "",
          to: hank.email_address,
          email: "",
          send_email: false,
          invite_base_url: "https://multibay.test",
        },
      },
    );
    const { invite_url } = await alice.client.call(
      "projects.copyEmailProjectInviteLink",
      {
        invite_id: sent.invites[0]?.invite_id,
        invite_base_url: "https://multibay.test",
      },
    );
    const link = decodeURIComponent(invite_url.split("/invites/")[1] ?? "");
    const post = async (endpoint, body, cookie) => {
      const res = await fetch(
        `${cluster.url(SEED)}/api/v2/projects/${endpoint}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(cookie ? { Cookie: `remember_me=${cookie}` } : {}),
          },
          body: JSON.stringify(body),
        },
      );
      return await res.json();
    };
    const anonymous = await post("preview-email-invite", { token: link });
    assert.match(`${anonymous.error}`, /Sign in/);
    const preview = await post(
      "preview-email-invite",
      { token: link },
      hank.client.cookie,
    );
    assert.equal(preview.error, undefined);
    assert.equal(preview.invite?.project_id, project);
    const accepted = await post(
      "respond-email-invite",
      { token: link, action: "accept" },
      hank.client.cookie,
    );
    assert.equal(accepted.error, undefined);
    await eventually(() => listed(hank.client, project), {
      what: "the project in hank's list",
    });
  });

  it("lets the owner remove the new collaborator", async () => {
    await bob.client.call("projects.removeCollaborator", {
      opts: { project_id: project, account_id: gina.account_id },
    });
    await eventually(async () => !(await listed(gina.client, project)), {
      what: "the project gone from gina's list",
    });
  });
});

describe("account-home facts on the owning bay", () => {
  // Admin status lives on the account's home bay. The owning bay of a
  // project must ask it, not its own (missing) copy of the account.
  let carol; // an admin homed on the seed

  it("recognizes an admin homed on the other bay", async () => {
    carol = await createAccount(cluster, { home_bay_id: SEED, name: "carol" });
    await runInBay(
      cluster,
      SEED,
      `const getPool = require("@cocalc/database/pool").default;
       await getPool().query(
         "UPDATE accounts SET groups=ARRAY['admin'] WHERE account_id=$1",
         [${JSON.stringify(carol.account_id)}]);`,
    );
    carol.client = await client(carol);
    // Owners and admins may change this policy; carol is not a member.
    await carol.client.call("projects.setProjectManageUsersOwnerOnly", {
      project_id: bob.project,
      manage_users_owner_only: true,
    });
    await carol.client.call("projects.setProjectManageUsersOwnerOnly", {
      project_id: bob.project,
      manage_users_owner_only: false,
    });
  });

  it("still refuses a non-admin, non-owner on the other bay", async () => {
    await assert.rejects(
      alice.client.call("projects.setProjectManageUsersOwnerOnly", {
        project_id: bob.project,
        manage_users_owner_only: true,
      }),
      /Only project owners and administrators/,
    );
  });
});

describe("admin entitlement overrides across bays", () => {
  // An admin homed on the seed manages a disk quota override on bob's
  // project, which lives on the attached bay.
  let admin;

  it("lets an admin on the other bay set, read and clear an override", async () => {
    admin = await createAccount(cluster, { home_bay_id: SEED, name: "ivy" });
    await runInBay(
      cluster,
      SEED,
      `const getPool = require("@cocalc/database/pool").default;
       await getPool().query(
         "UPDATE accounts SET groups=ARRAY['admin'] WHERE account_id=$1",
         [${JSON.stringify(admin.account_id)}]);`,
    );
    admin.client = await client(admin);
    const set = await admin.client.call(
      "projects.setAdminProjectEntitlementOverride",
      {
        project_id: bob.project,
        disk_quota_mb: 12345,
        reason: "multibay test",
      },
    );
    assert.ok(set);
    const read = await admin.client.call(
      "projects.getAdminProjectEntitlementOverride",
      { project_id: bob.project },
    );
    assert.equal(
      read?.override?.project_defaults?.disk_quota?.value ??
        read?.project_defaults?.disk_quota?.value,
      12345,
    );
    await admin.client.call("projects.clearAdminProjectEntitlementOverride", {
      project_id: bob.project,
      reason: "multibay test done",
    });
  });

  it("refuses a non-admin on the other bay", async () => {
    await assert.rejects(
      alice.client.call("projects.getAdminProjectEntitlementOverride", {
        project_id: bob.project,
      }),
      /must be an admin/,
    );
  });
});

describe("stuck archive reopen across bays", () => {
  // bob's project lives on the attached bay and is stuck in state archiving
  // under an automatic job stopped by files over the backup limit. An admin
  // homed on the seed asks to reopen it: the call is routed to the owning
  // bay, fresh auth and admin status come from the admin's home bay, and the
  // job and project there are what it acts on. The cluster has no project
  // hosts, so the host's freeze release fails and the reopen must refuse,
  // leaving the job and project exactly as they were.
  let admin;
  let project_id;
  const job_id = randomUUID();
  const stuckState = async () =>
    await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows: [job] } = await getPool().query(
         "SELECT status, failure_category, evidence FROM project_archive_lifecycle_jobs WHERE id=$1",
         [${JSON.stringify(job_id)}]);
       const { rows: [project] } = await getPool().query(
         "SELECT state ->> 'state' AS state, archive_lifecycle_job_id FROM projects WHERE project_id=$1",
         [${JSON.stringify(project_id)}]);
       return { job, project };`,
    );
  const forwarded = async () =>
    await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       const t = await getPool().query("SELECT to_regclass('hub_api_forwarded_calls') AS t");
       if (t.rows[0].t == null) return 0;
       const { rows } = await getPool().query(
         "SELECT COUNT(*)::INT AS n FROM hub_api_forwarded_calls WHERE name='projects.reopenStuckProjectArchive' AND source_bay_id=$1 AND account_id=$2 AND finished IS NOT NULL",
         [${JSON.stringify(SEED)}, ${JSON.stringify(admin.account_id)}]);
       return rows[0].n;`,
    );

  before(async () => {
    project_id = await createProject(bob.client, "stuck-archive");
    admin = await createAccount(cluster, { home_bay_id: SEED, name: "uma" });
    await runInBay(
      cluster,
      SEED,
      `const getPool = require("@cocalc/database/pool").default;
       await getPool().query(
         "UPDATE accounts SET groups=ARRAY['admin'] WHERE account_id=$1",
         [${JSON.stringify(admin.account_id)}]);`,
    );
    admin.client = await client(admin);
    // a host this cluster doesn't have: its freeze release cannot succeed
    await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       const { ensureProjectArchiveLifecycleSchema } = require("@cocalc/server/projects/archive-lifecycle-schema");
       await ensureProjectArchiveLifecycleSchema();
       const host_id = ${JSON.stringify(randomUUID())};
       await getPool().query(
         "INSERT INTO project_archive_lifecycle_jobs (id, project_id, owning_bay_id, host_id, reason, policy_version, status, report_only, failure_category, dedupe_key) VALUES ($1, $2, $3, $4, 'free-inactive', 1, 'failed', false, 'oversized-files', $5)",
         [${JSON.stringify(job_id)}, ${JSON.stringify(project_id)}, ${JSON.stringify(ATTACHED)}, host_id, ${JSON.stringify(`multibay:${job_id}`)}]);
       await getPool().query(
         "UPDATE projects SET state='{\\"state\\":\\"archiving\\"}'::jsonb, archive_lifecycle_job_id=$2 WHERE project_id=$1",
         [${JSON.stringify(project_id)}, ${JSON.stringify(job_id)}]);`,
    );
  });

  after(async () => {
    // leave bob's project usable for anything that runs later
    await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       await getPool().query(
         "UPDATE projects SET state='{\\"state\\":\\"opened\\"}'::jsonb, archive_lifecycle_job_id=NULL WHERE project_id=$1",
         [${JSON.stringify(project_id)}]);`,
    );
  });

  it("refuses a non-admin on the other bay", async () => {
    await assert.rejects(
      alice.client.call("projects.reopenStuckProjectArchive", {
        project_id,
        reason: "multibay test",
      }),
      /only an admin can reopen a stuck archive/,
    );
  });

  it("acts on the owning bay's job for an admin on the other bay, and refuses when the host can't release the freeze", async () => {
    const before = await forwarded();
    await assert.rejects(
      admin.client.call("projects.reopenStuckProjectArchive", {
        project_id,
        reason: "multibay test",
      }),
      (err) => {
        // past the auth and admin checks: it reached the owning bay's job
        // and asked for that job's host, which this cluster doesn't have
        assert.doesNotMatch(`${err?.message ?? err}`, /only an admin|fresh/i);
        return true;
      },
    );
    assert.equal(await forwarded(), before + 1);
    // the refusal rolled the reservation back with everything else
    const { job, project } = await stuckState();
    assert.equal(job.status, "failed");
    assert.equal(job.failure_category, "oversized-files");
    assert.equal(job.evidence?.admin_reopen_reservation, undefined);
    assert.equal(job.evidence?.admin_reopen, undefined);
    assert.deepEqual(project, {
      state: "archiving",
      archive_lifecycle_job_id: job_id,
    });
  });
});

describe("project archive across bays", () => {
  // An admin homed on the seed archives a project the attached bay owns:
  // the call is forwarded to the owning bay and handled there. This cluster
  // can't really archive (no backup repositories, workspace runtime), so the
  // owning bay refuses; but not with "not found", as the seed would.
  let admin;
  let project_id;
  const forwarded = async () =>
    await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       const t = await getPool().query("SELECT to_regclass('hub_api_forwarded_calls') AS t");
       if (t.rows[0].t == null) return 0;
       const { rows } = await getPool().query(
         "SELECT COUNT(*)::INT AS n FROM hub_api_forwarded_calls WHERE name='projects.archiveProject' AND source_bay_id=$1 AND account_id=$2 AND finished IS NOT NULL",
         [${JSON.stringify(SEED)}, ${JSON.stringify(admin.account_id)}]);
       return rows[0].n;`,
    );

  before(async () => {
    project_id = await createProject(bob.client, "archive-across-bays");
    admin = await createAccount(cluster, { home_bay_id: SEED, name: "vera" });
    await runInBay(
      cluster,
      SEED,
      `const getPool = require("@cocalc/database/pool").default;
       await getPool().query(
         "UPDATE accounts SET groups=ARRAY['admin'] WHERE account_id=$1",
         [${JSON.stringify(admin.account_id)}]);`,
    );
    admin.client = await client(admin);
  });

  it("runs on the project's owning bay for a caller homed on the other bay", async () => {
    const before = await forwarded();
    await assert.rejects(
      admin.client.call("projects.archiveProject", {
        project_id,
        timeout: 60_000,
      }),
      (err) => {
        assert.doesNotMatch(`${err?.message ?? err}`, /not found/i);
        return true;
      },
    );
    assert.equal(await forwarded(), before + 1);
  });
});

describe("sensor budgets on the account's home bay", () => {
  // carol is homed on the attached bay; her watchers are set from the seed,
  // as when one of her agents works in a project the seed owns. The budget
  // calls cross the real fabric and are counted only on her home bay.
  let carol;
  let project_id;
  const agent_id = randomUUID();
  // Runs the budget calls on the seed, as the sensor code does, and returns
  // each outcome (an error's message instead of throwing).
  const fromSeed = (calls) =>
    runInBay(
      cluster,
      SEED,
      `const { sensorBudget } = server("agents/cocalc-connector-routing.js");
       const out = [];
       for (const [method, opts] of ${JSON.stringify(calls)}) {
         try {
           out.push({ ok: true, r: (await sensorBudget[method](opts)) ?? null });
         } catch (err) {
           out.push({ ok: false, error: String(err?.message ?? err) });
         }
       }
       return out;`,
    );
  const watcher = () => ({
    account_id: carol.account_id,
    project_id,
    agent_id,
    sensor_id: randomUUID(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });

  before(async () => {
    carol = await createAccount(cluster, {
      home_bay_id: ATTACHED,
      name: "carol",
    });
    // alice's own project: a new one would use up her project limit, which
    // later scenarios need.
    project_id = alice.project;
    assert.equal(await owningBay(project_id), SEED);
    // Two wakes a day: the watcher cap against churn is then 4 x 2 = 8.
    await runInBay(
      cluster,
      ATTACHED,
      `const { setAccountEntitlementOverrideLocal } = server("membership/entitlement-overrides.js");
       await setAccountEntitlementOverrideLocal({
         account_id: ${JSON.stringify(carol.account_id)},
         actor_account_id: ${JSON.stringify(carol.account_id)},
         override: { usage_limits: { sensor_max_wakes_per_day: { mode: "set", value: 2 } } },
         reason: "multibay sensor budget test",
       });`,
    );
  });

  it("counts watchers set from another bay on the home bay, capped only against churn", async () => {
    // Set and released (never fired) eight times: more than the two wakes,
    // which watchers no longer use up until they fire.
    const calls = [];
    for (let i = 0; i < 8; i++) {
      const w = watcher();
      calls.push(["reserveWatcher", w]);
      calls.push([
        "releaseWatcher",
        { account_id: w.account_id, sensor_id: w.sensor_id },
      ]);
    }
    calls.push(["reserveWatcher", watcher()]);
    const out = await fromSeed(calls);
    assert.deepEqual(
      out.slice(0, 16).map((o) => o.ok),
      Array(16).fill(true),
      JSON.stringify(out),
    );
    assert.equal(out[16].ok, false);
    assert.match(out[16].error, /at most 8 watchers a day/);
    assert.deepEqual(await countsFor(ATTACHED), { watch: 8 });
    assert.deepEqual(await countsFor(SEED), {});
  });

  it("refuses a watcher on the home bay once the day's wakes are spent", async () => {
    const wake = () => ({
      account_id: carol.account_id,
      project_id,
      agent_id,
      sensor_id: randomUUID(),
      run_id: randomUUID(),
    });
    const out = await fromSeed([
      ["reserveWake", wake()],
      ["reserveWake", wake()],
      ["reserveWake", wake()],
      ["reserveWatcher", watcher()],
    ]);
    assert.deepEqual(
      out.slice(0, 3).map((o) => o.r?.reserved),
      [true, true, false],
      JSON.stringify(out),
    );
    // Checked before the churn cap: it could never wake the agent.
    assert.equal(out[3].ok, false);
    assert.match(out[3].error, /used all 2 wakes/);
    assert.deepEqual(await countsFor(ATTACHED), { wake: 2, watch: 8 });
    assert.deepEqual(await countsFor(SEED), {});
  });

  it("reads a ci watcher's GitHub grant on the home bay, from another bay", async () => {
    // A ci watcher is refused, or gives up, unless the agent has the GitHub
    // connector. Grants live on the account's home bay (here the attached
    // one); the check runs where the project is (the seed) and issues no
    // token.
    const grant_id = randomUUID();
    const hasGithub = async (opts = {}) =>
      await runInBay(
        cluster,
        SEED,
        `const { sensorConnectors } = server("agents/cocalc-connector-routing.js");
         return await sensorConnectors.hasCli(${JSON.stringify({
           account_id: carol.account_id,
           agent_id,
           source_project_id: project_id,
           connector: "github",
           ...opts,
         })});`,
      );
    const setGrant = async (sql, params) =>
      await runInBay(
        cluster,
        ATTACHED,
        `const getPool = require("@cocalc/database/pool").default;
         await getPool().query(${JSON.stringify(sql)}, ${JSON.stringify(params)});`,
      );
    assert.equal(await hasGithub(), false);
    await setGrant(
      "INSERT INTO agent_connector_grants (grant_id, account_id, agent_id, source_project_id, connector, connection_id, scope, enabled) VALUES ($1, $2, $3, $4, 'github', $5, '{}'::jsonb, true)",
      [grant_id, carol.account_id, agent_id, project_id, randomUUID()],
    );
    assert.equal(await hasGithub(), true);
    // Only this agent, this project and this connector.
    assert.equal(await hasGithub({ agent_id: randomUUID() }), false);
    assert.equal(await hasGithub({ connector: "cloudflare" }), false);
    // Turned off, or its connection gone: no longer counts.
    await setGrant(
      "UPDATE agent_connector_grants SET enabled=false WHERE grant_id=$1",
      [grant_id],
    );
    assert.equal(await hasGithub(), false);
    await setGrant(
      "UPDATE agent_connector_grants SET enabled=true, connection_id=NULL WHERE grant_id=$1",
      [grant_id],
    );
    assert.equal(await hasGithub(), false);
    // Nothing about the grant reached the seed's own database.
    assert.equal(
      await runInBay(
        cluster,
        SEED,
        `const getPool = require("@cocalc/database/pool").default;
         const { rows } = await getPool().query(
           "SELECT count(*)::int AS n FROM agent_connector_grants WHERE account_id=$1",
           [${JSON.stringify(carol.account_id)}]);
         return rows[0].n;`,
      ),
      0,
    );
  });

  it("keeps reminders set from another bay on the home bay, under their own cap", async () => {
    // dave, also homed on the attached bay, with two wakes a day. A reminder
    // may be far ahead; it is counted as a reminder, not a watcher, released
    // when deleted, and refused only when it is due before the day's wakes
    // come back.
    const dave = await createAccount(cluster, {
      home_bay_id: ATTACHED,
      name: "dave",
    });
    await runInBay(
      cluster,
      ATTACHED,
      `const { setAccountEntitlementOverrideLocal } = server("membership/entitlement-overrides.js");
       await setAccountEntitlementOverrideLocal({
         account_id: ${JSON.stringify(dave.account_id)},
         actor_account_id: ${JSON.stringify(dave.account_id)},
         override: { usage_limits: { sensor_max_wakes_per_day: { mode: "set", value: 2 } } },
         reason: "multibay sensor reminder test",
       });`,
    );
    const reminder = (hours) => ({
      account_id: dave.account_id,
      project_id,
      agent_id,
      sensor_id: randomUUID(),
      // A reminder's reservation ends an hour after it is due.
      expires_at: new Date(Date.now() + (hours + 1) * 3_600_000).toISOString(),
      reminder: true,
    });
    const wake = () => ({
      account_id: dave.account_id,
      project_id,
      agent_id,
      sensor_id: randomUUID(),
      run_id: randomUUID(),
    });
    const deleted = reminder(90 * 24);
    const out = await fromSeed([
      ["reserveWatcher", deleted],
      [
        "releaseWatcher",
        { account_id: dave.account_id, sensor_id: deleted.sensor_id },
      ],
      ["reserveWake", wake()],
      ["reserveWake", wake()],
      // Due within the day, after its wakes are spent: it could not fire.
      ["reserveWatcher", reminder(0.5)],
      // Due in two months: the wakes are back by then.
      ["reserveWatcher", reminder(60 * 24)],
    ]);
    assert.deepEqual(
      out.map((o) => o.ok),
      [true, true, true, true, false, true],
      JSON.stringify(out),
    );
    assert.match(out[4].error, /used all 2 wakes/);
    assert.deepEqual(await countsFor(ATTACHED, dave), {
      reminder: 2,
      wake: 2,
    });
    assert.deepEqual(await countsFor(SEED, dave), {});
    assert.equal(
      await runInBay(
        cluster,
        ATTACHED,
        `const getPool = require("@cocalc/database/pool").default;
         const { rows } = await getPool().query(
           "SELECT released_at IS NOT NULL AS released FROM agent_sensor_events WHERE account_id=$1 AND sensor_id=$2",
           [${JSON.stringify(dave.account_id)}, ${JSON.stringify(deleted.sensor_id)}]);
         return rows[0]?.released ?? null;`,
      ),
      true,
    );
  });

  async function countsFor(bay, account = carol) {
    return await runInBay(
      cluster,
      bay,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT kind, count(*)::int AS n FROM agent_sensor_events WHERE account_id=$1 GROUP BY kind ORDER BY kind",
         [${JSON.stringify(account.account_id)}]);
       return Object.fromEntries(rows.map((r) => [r.kind, r.n]));`,
    );
  }
});

describe("site-license ownership transfer across bays", () => {
  // Site licenses and their pools live on the seed. An admin homed on the
  // attached bay transfers a seed license owned by alice (seed) to bob
  // (attached), through the public API and the inter-bay seed client.
  let admin;
  let site_license_id;

  async function seedOwners() {
    return await runInBay(
      cluster,
      SEED,
      `const getPool = require("@cocalc/database/pool").default;
       const id = ${JSON.stringify(site_license_id)};
       const license = await getPool().query(
         "SELECT owner_account_id::text AS owner FROM site_licenses WHERE id=$1::uuid", [id]);
       const pools = await getPool().query(
         "SELECT owner_account_id::text AS owner FROM membership_packages WHERE kind='site' AND metadata->>'site_license_id'=$1::text ORDER BY created", [id]);
       return { license: license.rows[0]?.owner ?? null, pools: pools.rows.map((r) => r.owner) };`,
    );
  }

  it("lets an admin homed on the attached bay transfer a seed license and its pools", async () => {
    admin = await createAccount(cluster, {
      home_bay_id: ATTACHED,
      name: "zara",
    });
    await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       await getPool().query(
         "UPDATE accounts SET groups=ARRAY['admin'] WHERE account_id=$1",
         [${JSON.stringify(admin.account_id)}]);`,
    );
    admin.client = await client(admin);
    site_license_id = await runInBay(
      cluster,
      SEED,
      `const { createTestMembershipTier } = server("purchases/test-data.js");
       const { adminProvisionSiteLicense } = server("membership/site-licenses.js");
       const tier = "multibay-site-" + ${JSON.stringify(randomUUID().slice(0, 8))};
       await createTestMembershipTier({ id: tier, priority: 10, price_yearly: 100 });
       const pool = (pool_name, seat_count) => ({
         pool_name, membership_class: tier, seat_count, requires_approval: false,
         verification_policy: "email-domain", exclusive_group: "teaching" });
       const overview = await adminProvisionSiteLicense({
         actor_account_id: ${JSON.stringify(alice.account_id)},
         owner_account_id: ${JSON.stringify(alice.account_id)},
         name: "Multibay Transfer Campus",
         organization_name: "Multibay University",
         allowed_domains: ["multibay-transfer-" + ${JSON.stringify(randomUUID().slice(0, 8))} + ".edu"],
         pools: [pool("Students", 10), pool("Instructors", 2)],
         trusted_admin: true,
       });
       return overview.site_license.id;`,
    );
    assert.deepEqual(await seedOwners(), {
      license: alice.account_id,
      pools: [alice.account_id, alice.account_id],
    });

    const overview = await admin.client.call("purchases.updateSiteLicense", {
      site_license_id,
      owner_account_id: bob.account_id,
    });
    assert.equal(overview.site_license.owner_account_id, bob.account_id);
    assert.deepEqual(await seedOwners(), {
      license: bob.account_id,
      pools: [bob.account_id, bob.account_id],
    });
    const read = await admin.client.call("purchases.getSiteLicenseOverview", {
      site_license_id,
    });
    assert.equal(read.site_license.owner_account_id, bob.account_id);
    assert.ok(
      read.recent_audit_events.some(
        (event) =>
          event.action === "site-license-owner-transferred" &&
          event.metadata?.previous_owner_account_id === alice.account_id &&
          event.metadata?.owner_account_id === bob.account_id,
      ),
    );
  });

  it("refuses an ownership transfer by a non-admin on the attached bay", async () => {
    await assert.rejects(
      bob.client.call("purchases.updateSiteLicense", {
        site_license_id,
        owner_account_id: alice.account_id,
      }),
      /admin/,
    );
    assert.equal((await seedOwners()).license, bob.account_id);
  });
});

describe("fabric faults", () => {
  it("answers a change on the owning bay while the other bay is frozen", async () => {
    // alice (homed on the seed) collaborates on bob's project. With the seed
    // frozen, bob's rename on the bay that owns the project must still answer
    // promptly; the new title reaches alice once the seed resumes.
    const title = "while the seed is frozen";
    let elapsed;
    cluster.signal(SEED, "SIGSTOP");
    try {
      const start = Date.now();
      await rename(bob.client, bob.project, title);
      elapsed = Date.now() - start;
    } finally {
      cluster.signal(SEED, "SIGCONT");
    }
    assert.ok(elapsed < 5_000, `the rename took ${elapsed}ms`);
    await eventually(
      async () => (await listed(alice.client, bob.project))?.title === title,
      { timeoutMs: 60_000, what: `${title} to reach the seed` },
    );
  });

  it("creates a mention for an account on a frozen bay without waiting for it", async () => {
    // bob (homed on the attached bay) is a collaborator on alice's seed-owned
    // project again. With his bay frozen, alice's mention is recorded on the
    // seed and delivered once his bay resumes.
    await invite(alice, bob, alice.project);
    await eventually(() => listed(bob.client, alice.project), {
      what: "alice's project back in bob's list",
    });
    const description = "mentioned while bob's bay is frozen";
    let elapsed;
    cluster.signal(ATTACHED, "SIGSTOP");
    try {
      const start = Date.now();
      await alice.client.call("notifications.createMention", {
        source_project_id: alice.project,
        source_path: "notes.md",
        description,
        target_account_ids: [bob.account_id],
      });
      elapsed = Date.now() - start;
    } finally {
      cluster.signal(ATTACHED, "SIGCONT");
    }
    assert.ok(elapsed < 5_000, `the mention took ${elapsed}ms`);
    await eventually(
      async () =>
        (await bob.client.call("notifications.list", { limit: 50 })).some(
          (row) => row.summary?.description === description,
        ),
      { timeoutMs: 60_000, what: "the mention to reach bob" },
    );
  });

  it("keeps the attached bay working for its own accounts while the seed is frozen", async () => {
    // Everything here concerns only bob and his own bay. The seed holds the
    // cluster directory and global configuration, but bay-1 must not need it
    // for its own accounts.
    const timed = async (what, limitMs, fn) => {
      const start = Date.now();
      const result = await fn();
      const elapsed = Date.now() - start;
      assert.ok(elapsed < limitMs, `${what} took ${elapsed}ms`);
      return result;
    };
    let project_id;
    cluster.signal(SEED, "SIGSTOP");
    try {
      const bay = await timed("looking up his home bay", 5_000, () =>
        bob.client.call("system.getAccountBay", {}),
      );
      assert.equal(bay.home_bay_id, ATTACHED);
      project_id = await timed("creating a project", 10_000, () =>
        createProject(bob.client, "created while the seed is frozen"),
      );
      await timed("renaming it", 5_000, () =>
        rename(bob.client, project_id, "renamed while the seed is frozen"),
      );
      await eventually(
        async () =>
          (await listed(bob.client, project_id))?.title ===
          "renamed while the seed is frozen",
        { timeoutMs: 20_000, what: "the renamed project in bob's list" },
      );
    } finally {
      cluster.signal(SEED, "SIGCONT");
    }
    // Once the seed is back, the project works across bays like any other.
    assert.equal(await owningBay(project_id), ATTACHED);
    await invite(bob, alice, project_id);
    await eventually(() => listed(alice.client, project_id), {
      timeoutMs: 60_000,
      what: "bob's new project in alice's list",
    });
  });

  it("recovers after the seed's event loop stalls", async () => {
    cluster.signal(SEED, "SIGSTOP");
    await sleep(8_000);
    cluster.signal(SEED, "SIGCONT");
    await assertCrossBayRename(
      bob.client,
      alice.client,
      bob.project,
      "after a seed stall",
    );
  });

  it("reconnects every bay after the seed evicts them all", async () => {
    // While the registry is unreadable, the seed's revocation sweep fails
    // closed and disconnects every bay principal, including its own fabric
    // client. Once it is readable again the fabric must heal by itself.
    const EVICTED =
      "failed to check bay credential revocations; disconnecting bay connections";
    const before = seedLog().split(EVICTED).length;
    await lockCredentialRegistry(15);
    assert.ok(
      seedLog().split(EVICTED).length > before,
      "the seed should have evicted the bays while the registry was locked",
    );
    await assertCrossBayRename(
      bob.client,
      alice.client,
      bob.project,
      "after a fabric eviction",
    );
    await assertCrossBayRename(
      alice.client,
      bob.client,
      bob.project,
      "after a fabric eviction, seed side",
    );
  });

  it("recovers after the attached bay restarts", async () => {
    await cluster.restartBay(ATTACHED);
    await assertCrossBayRename(
      alice.client,
      bob.client,
      bob.project,
      "after an attached bay restart",
    );
  });
  it("starts an attached bay while the seed's registry is unreadable", async () => {
    // The bay's fabric handshakes are rejected until the registry answers;
    // startup must wait for them rather than exit.
    await cluster.stopBay(ATTACHED);
    const locked = lockCredentialRegistry(20);
    await sleep(2_000);
    cluster.startBay(ATTACHED);
    await locked;
    await cluster.waitReady(ATTACHED);
    await assertCrossBayRename(
      alice.client,
      bob.client,
      bob.project,
      "after starting during a registry outage",
    );
  });
});

describe("computers across bays", () => {
  // Carol is homed on the attached bay: her computers and their pairing
  // requests live there, whichever bay a call starts at. Stage 1 serves only
  // projects her home bay owns, so a seed-owned project is refused there.
  // Design: src/.agents/computers-direct-host-2026-10-16.md.
  let carol;

  before(async () => {
    carol = await createAccount(cluster, {
      home_bay_id: ATTACHED,
      name: "carol",
    });
    carol.client = await client(carol);
  });

  it("a request made at the seed runs at carol's home, which refuses a seed-owned project", async () => {
    // A seed project whose only collaborator is carol.
    const project = await createProject(alice.client, "computers");
    await invite(alice, carol, project);
    await eventually(() => listed(carol.client, project), {
      what: "the project in carol's list",
    });
    await alice.client.call("projects.transferProjectOwnership", {
      project_id: project,
      from_account_id: alice.account_id,
      to_account_id: carol.account_id,
    });
    await eventually(
      async () =>
        (await listed(carol.client, project))?.users_summary?.[carol.account_id]
          ?.group === "owner",
      { what: "carol to own it" },
    );
    await carol.client.call("projects.removeCollaborator", {
      opts: { project_id: project, account_id: alice.account_id },
    });
    assert.equal(await owningBay(project), SEED);

    const result = await runInBay(
      cluster,
      SEED,
      `const { computersAtAccountHome } = server("computers/routing.js");
       const account_id = ${JSON.stringify(carol.account_id)};
       const home = await computersAtAccountHome(account_id);
       let error = null;
       try {
         await home.createRequest({ account_id, name: "bench", project_id: ${JSON.stringify(project)} });
       } catch (err) {
         error = String(err?.message ?? err);
       }
       return { error, requests: await home.listRequests({ account_id }) };`,
    );
    assert.match(result.error ?? "", /no such project here/);
    assert.deepEqual(result.requests, []);
  });
});

describe("an agent's own network name across bays", () => {
  // Erin is homed on the attached bay, so her agent names and Agent Networks
  // live there; her agent runs in a seed-owned project, so only the seed can
  // prove the run. An agent asking for its own @name crosses both ways: to
  // the account's home for discovery, and back to the project's bay for the
  // run principal (agent.describeNetworkSelf, after its host check).
  let erin;
  let project;
  const agent = randomUUID();
  const peer = randomUUID();
  const run = randomUUID();

  before(async () => {
    erin = await createAccount(cluster, {
      home_bay_id: ATTACHED,
      name: "erin",
    });
    erin.client = await client(erin);
    project = await createProject(alice.client, "agent-names");
    await invite(alice, erin, project);
    await eventually(() => listed(erin.client, project), {
      what: "the project in erin's list",
    });
    assert.equal(await owningBay(project), SEED);
    // The agents and an issued run, on the project's bay.
    await runInBay(
      cluster,
      SEED,
      `const getPool = require("@cocalc/database/pool").default;
       const { agentStore } = server("agents/store.js");
       for (const [id, thread] of [[${JSON.stringify(agent)}, "ops"], [${JSON.stringify(peer)}, "reviewer"]])
         await getPool().query(
           "INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by) VALUES($1,$2,'/home/user/agents.chat',$3,'claude-1',$4)",
           [id, ${JSON.stringify(project)}, thread, ${JSON.stringify(erin.account_id)}]);
       const db = agentStore();
       await db.issue(await db.get(${JSON.stringify(agent)}), ${JSON.stringify(run)}, ${JSON.stringify(erin.account_id)});`,
    );
    // Erin's names for them and her network, at her home.
    await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       const crypto = require("node:crypto");
       const account = ${JSON.stringify(erin.account_id)};
       const project = ${JSON.stringify(project)};
       for (const [id, name, thread] of [[${JSON.stringify(agent)}, "ops1", "ops"], [${JSON.stringify(peer)}, "review", "reviewer"]])
         await getPool().query(
           "INSERT INTO agent_personal_names(account_id,name,project_id,agent_id,metadata) VALUES($1,$2,$3,$4,$5)",
           [account, name, project, id, { path: "/home/user/agents.chat", thread_id: thread }]);
       const network = crypto.randomUUID();
       await getPool().query(
         "INSERT INTO agent_networks(agent_network_id,account_id,title,generation,created_by,delivery_mode) VALUES($1,$2,'cocalc-dev',$3,$2,'live')",
         [network, account, crypto.randomUUID()]);
       for (const id of [${JSON.stringify(agent)}, ${JSON.stringify(peer)}])
         await getPool().query(
           "INSERT INTO agent_network_members(agent_network_id,member_kind,member_id,registered_agent_id,project_id,added_by) VALUES($1,'registered',$2,$2,$3,$4)",
           [network, id, project, account]);`,
    );
  });

  async function discover(run_id) {
    return await runInBay(
      cluster,
      SEED,
      `const { withPersonalHome } = server("agents/personal.js");
       return await withPersonalHome(${JSON.stringify(erin.account_id)}, {
         action: "discoverNetworks",
         options: {
           source: { agent_id: ${JSON.stringify(agent)}, project_id: ${JSON.stringify(project)} },
           run_id: ${JSON.stringify(run_id)},
         },
       });`,
    );
  }

  it("names the agent as its peers see it, from the account's home bay", async () => {
    const found = await discover(run);
    assert.equal(found.self?.name, "ops1");
    assert.deepEqual(
      found.self.networks.map(({ title, delivery_mode }) => ({
        title,
        delivery_mode,
      })),
      [{ title: "cocalc-dev", delivery_mode: "live" }],
    );
    // The asker is not its own peer.
    assert.deepEqual(
      found.peers.map(({ member }) => member.name),
      ["review"],
    );
  });

  it("refuses a run the project's bay never issued", async () => {
    await assert.rejects(
      discover(randomUUID()),
      /expired, revoked, or invalid/,
    );
  });
});

describe("CLI logout across bays", () => {
  // `cocalc auth logout` must end the profile's session where it lives: on
  // the account's home bay, which issued the cookie.
  it("revokes the session on the profile's home bay", async () => {
    const carol = await createAccount(cluster, {
      home_bay_id: ATTACHED,
      name: "carol",
    });
    const session = await new AccountClient(cluster, carol).signIn();
    session.close();
    const sessions = () =>
      runInBay(
        cluster,
        ATTACHED,
        `const { getRememberMeHashFromCookieValue } = server("auth/remember-me.js");
         const getPool = require("@cocalc/database/pool").default;
         const hash = getRememberMeHashFromCookieValue(${JSON.stringify(session.cookie)});
         const { rows } = await getPool().query(
           "SELECT count(*)::int AS n FROM remember_me WHERE hash = $1::CHAR(127)",
           [hash.slice(0, 127)],
         );
         return rows[0].n;`,
      );
    assert.equal(await sessions(), 1);

    const dir = mkdtempSync(path.join(tmpdir(), "multibay-logout-"));
    const config = path.join(dir, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        current_profile: "carol",
        profiles: {
          carol: {
            api: cluster.url(ATTACHED),
            cookie: `remember_me=${session.cookie}`,
          },
        },
      }),
      { mode: 0o600 },
    );
    // A clean CLI environment: no ambient credentials or API defaults.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("COCALC_")),
    );
    const result = spawnSync(
      process.execPath,
      [
        path.join(SRC, "packages/cli/dist/bin/cocalc.js"),
        "--json",
        "auth",
        "logout",
      ],
      {
        env: { ...env, HOME: dir, COCALC_CLI_CONFIG: config },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.data.removed, "carol");
    assert.equal(output.data.server_session, "revoked");
    assert.equal(await sessions(), 0);
    assert.deepEqual(JSON.parse(readFileSync(config, "utf8")).profiles, {});
  });
});

describe("session idle timeout across bays", () => {
  // Sessions live on the account's home bay. A cookie checked through
  // another bay (inter-bay getAccountIdFromRememberMe) must count as use
  // there, and an idle session must be refused there.
  it("keeps a session used through another bay alive, and refuses it once idle", async () => {
    const dana = await createAccount(cluster, {
      home_bay_id: ATTACHED,
      name: "dana",
    });
    const session = await new AccountClient(cluster, dana).signIn();
    session.close();
    const hashCode = `const { getRememberMeHashFromCookieValue } = server("auth/remember-me.js");
       const getPool = require("@cocalc/database/pool").default;
       const hash = getRememberMeHashFromCookieValue(${JSON.stringify(session.cookie)}).slice(0, 127);`;
    const onHome = (sql) =>
      runInBay(
        cluster,
        ATTACHED,
        `${hashCode}
         const { rows } = await getPool().query(${JSON.stringify(sql)}, [hash]);
         return rows[0] ?? null;`,
      );
    const checkThroughSeed = () =>
      runInBay(
        cluster,
        SEED,
        `${hashCode}
         const { createInterBayAccountLocalClient } = require("@cocalc/conat/inter-bay/api");
         const { getInterBayFabricClient } = server("inter-bay/fabric.js");
         const client = createInterBayAccountLocalClient({
           client: getInterBayFabricClient(),
           dest_bay: ${JSON.stringify(ATTACHED)},
           timeout: 10000,
         });
         return (await client.getAccountIdFromRememberMe({ hash })).account_id ?? null;`,
      );

    // About to go idle: last used 13 days ago, with a long lifetime left
    // (the harness signs in with short sessions).
    await onHome(
      "UPDATE remember_me SET last_used = NOW() - INTERVAL '13 days', expire = NOW() + INTERVAL '1 day', max_expire = NOW() + INTERVAL '30 days' WHERE hash = $1::CHAR(127) RETURNING hash",
    );
    assert.equal(await checkThroughSeed(), dana.account_id);
    await eventually(async () => {
      const row = await onHome(
        "SELECT EXTRACT(EPOCH FROM expire - NOW()) / 86400 AS days_left FROM remember_me WHERE hash = $1::CHAR(127)",
      );
      assert.ok(Number(row.days_left) > 13, `days left: ${row.days_left}`);
      return true;
    });

    // Unused past the idle timeout: refused through the other bay too, and
    // maintenance deletes it.
    await onHome(
      "UPDATE remember_me SET last_used = NOW() - INTERVAL '15 days', expire = NOW() - INTERVAL '1 day' WHERE hash = $1::CHAR(127) RETURNING hash",
    );
    assert.equal(await checkThroughSeed(), null);
    await runInBay(
      cluster,
      ATTACHED,
      `const { runSessionMaintenance } = server("auth/session-expiry.js");
       return await runSessionMaintenance();`,
    );
    assert.equal(
      await onHome("SELECT hash FROM remember_me WHERE hash = $1::CHAR(127)"),
      null,
    );
  });
});

describe("managed egress notices", () => {
  // The bay that evaluates an egress policy (e.g. the one owning the
  // project's host) is often not the account's home bay. The notice must
  // still reach the account's own notification list.
  //
  // A notice's id depends on its UTC day: every send and lookup here uses
  // this one instant, so a run across midnight cannot mix two days' ids.
  const NOW = new Date().toISOString();
  const notifyOn = async (bay, account) =>
    await runInBay(
      cluster,
      bay,
      `const { notifyManagedEgressLimit } = server("notifications/managed-egress.js");
       return await notifyManagedEgressLimit({ ...${JSON.stringify({
         account_id: account.account_id,
         pool: "shared",
         window: "7d",
         used: 2100,
         limit: 2000,
         blocked: true,
       })}, now: new Date(${JSON.stringify(NOW)}) });`,
    );

  // This notice's own outbox rows: earlier scenarios leave other
  // notifications for the same accounts.
  const outbox = async (bay, account) =>
    await runInBay(
      cluster,
      bay,
      `const getPool = require("@cocalc/database/pool").default;
       const { managedEgressNotificationId } = server("notifications/managed-egress.js");
       const id = managedEgressNotificationId(
         "managed-egress:shared:7d:blocked:" + ${JSON.stringify(account.account_id)},
         new Date(${JSON.stringify(NOW)}));
       const { rows } = await getPool().query(
         "SELECT target_home_bay_id, published_at IS NOT NULL AS published FROM notification_target_outbox WHERE target_account_id=$1 AND notification_id=$2",
         [${JSON.stringify(account.account_id)}, id]);
       return rows;`,
    );

  const noticeIn = async (account) =>
    (await account.client.call("notifications.list", { limit: 50 })).filter(
      (row) => row.summary?.notice_type === "managed_egress_blocked",
    );

  for (const [evaluating, who] of [
    [SEED, "bob"],
    [ATTACHED, "alice"],
  ]) {
    it(`delivers a block notice evaluated on ${evaluating} to ${who}'s home bay, once a day`, async () => {
      const account = who === "bob" ? bob : alice;
      assert.notEqual(account.home_bay_id, evaluating);
      assert.equal(await notifyOn(evaluating, account), true);
      const [notice] = await eventually(
        async () => {
          const rows = await noticeIn(account);
          return rows.length > 0 ? rows : undefined;
        },
        { timeoutMs: 60_000, what: `the egress notice to reach ${who}` },
      );
      assert.equal(
        notice.summary.title,
        "Managed network traffic limit reached",
      );
      assert.match(notice.summary.body_markdown, /2\.1 KB of 2 KB/);
      // the source bay addressed and published it to the home bay
      await eventually(
        async () => {
          const rows = await outbox(evaluating, account);
          return (
            rows.length === 1 &&
            rows[0].target_home_bay_id === account.home_bay_id &&
            rows[0].published
          );
        },
        { what: `${evaluating}'s outbox row for ${who} to be published` },
      );
      // deduplicated on the evaluating bay
      assert.equal(await notifyOn(evaluating, account), false);
      await sleep(2_000);
      assert.equal((await noticeIn(account)).length, 1);
    });
  }

  it("merges the same notice sent by both bays into one notice and one email on the home bay", async () => {
    // bob's projects can be metered on both bays; each may send the notice
    const input = {
      account_id: bob.account_id,
      pool: "control-plane",
      window: "5h",
      used: 11_000_000_000,
      limit: 10_000_000_000,
      blocked: true,
    };
    const send = async (bay) =>
      await runInBay(
        cluster,
        bay,
        `const { notifyManagedEgressLimit, managedEgressNotificationId } =
           server("notifications/managed-egress.js");
         const now = new Date(${JSON.stringify(NOW)});
         const sent = await notifyManagedEgressLimit({ ...${JSON.stringify(input)}, now });
         return { sent, id: managedEgressNotificationId(
           "managed-egress:control-plane:5h:blocked:" + ${JSON.stringify(bob.account_id)}, now) };`,
      );
    const fromSeed = await send(SEED);
    const fromHome = await send(ATTACHED);
    assert.deepEqual([fromSeed.sent, fromHome.sent], [true, true]);
    assert.equal(fromSeed.id, fromHome.id);
    const isThisNotice = (row) =>
      row.summary?.title === "Browser control traffic limit reached";
    await eventually(
      async () =>
        (await runInBay(
          cluster,
          SEED,
          `const getPool = require("@cocalc/database/pool").default;
             const { rows } = await getPool().query(
               "SELECT 1 FROM notification_target_outbox WHERE notification_id=$1 AND published_at IS NOT NULL",
               [${JSON.stringify(fromSeed.id)}]);
             return rows.length;`,
        )) === 1,
      { what: "the seed's copy to be published to bob's home bay" },
    );
    await eventually(
      async () =>
        (await bob.client.call("notifications.list", { limit: 50 })).some(
          isThisNotice,
        ),
      { timeoutMs: 60_000, what: "the control-plane notice to reach bob" },
    );
    await sleep(3_000);
    const notices = (
      await bob.client.call("notifications.list", { limit: 50 })
    ).filter(isThisNotice);
    assert.equal(notices.length, 1);
    const emails = await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT count(*)::INT AS n FROM notification_email_outbox WHERE target_account_id=$1 AND notification_id=$2",
         [${JSON.stringify(bob.account_id)}, ${JSON.stringify(fromSeed.id)}]);
       return rows[0].n;`,
    );
    assert.equal(emails, 1, `${emails} email outbox rows for one notice`);
  });
});

describe("membership-seat order fulfillment across bays", () => {
  // Commercial orders live on the seed; membership packages are account-home
  // state. Recording fulfillment on the seed for a customer homed on the
  // attached bay must read the packages from that bay.
  async function makeAdmin(account) {
    for (const bay of [SEED, ATTACHED]) {
      await runInBay(
        cluster,
        bay,
        `const getPool = require("@cocalc/database/pool").default;
         await getPool().query(
           "UPDATE accounts SET groups=ARRAY['admin'] WHERE account_id=$1",
           [${JSON.stringify(account.account_id)}]);`,
      );
    }
  }

  async function recordOnSeed({ admin, customer }) {
    const serviceEnds = new Date(Date.now() + 100 * 86_400_000).toISOString();
    const order = await runInBay(
      cluster,
      SEED,
      `const store = server("commercial-orders/store.js");
       const actor = ${JSON.stringify(admin.account_id)};
       const created = await store.createCommercialOrder({
         account_id: actor,
         reason: "multibay membership order",
         source: "cli",
         idempotency_key: "multibay-membership-" + ${JSON.stringify(randomUUID())},
         organization_name: "Multibay Membership University",
         customer_account_id: ${JSON.stringify(customer.account_id)},
         collection_mode: "manual_invoice",
         agreed_subtotal: "100",
         agreed_total: "100",
         service_ends_at: ${JSON.stringify(serviceEnds)},
         next_action: "Approve agreement",
         next_action_due_at: new Date(Date.now() + 86400000).toISOString(),
         items: [{ description: "Student seats", quantity: "1", unit_amount: "100",
                   subtotal: "100", product_kind: "membership_package" }],
         contacts: [{ role: "billing", name_snapshot: "AP", email_snapshot: "ap@multibay.edu" }],
       });
       const approved = await store.approveCommercialOrder({
         account_id: actor, id: created.id, expected_version: created.version,
         reason: "approve multibay membership order" });
       return { id: approved.id, order_number: approved.order_number, version: approved.version };`,
    );
    const package_id = randomUUID();
    await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       await getPool().query(
         "INSERT INTO membership_packages (id, owner_account_id, kind, membership_class, seat_count, starts_at, expires_at, metadata, created, updated) VALUES ($1::uuid, $2::uuid, 'team', 'student', 3, NOW() - interval '1 day', $3::timestamp + interval '3 days', $4::jsonb, NOW(), NOW())",
         [${JSON.stringify(package_id)}, ${JSON.stringify(customer.account_id)}, ${JSON.stringify(serviceEnds)},
          JSON.stringify({ commercial_order_number: ${JSON.stringify(order.order_number)} })]);`,
    );
    // The package exists only on the customer's home bay.
    assert.equal(
      await runInBay(
        cluster,
        SEED,
        `const getPool = require("@cocalc/database/pool").default;
         const { rows } = await getPool().query(
           "SELECT count(*)::int AS n FROM membership_packages WHERE id=$1::uuid",
           [${JSON.stringify(package_id)}]);
         return rows[0].n;`,
      ),
      0,
    );

    const recorded = await runInBay(
      cluster,
      SEED,
      `const { recordCommercialMembershipFulfillment } = server("commercial-orders/fulfillment/membership.js");
       const result = await recordCommercialMembershipFulfillment({
         id: ${JSON.stringify(order.id)},
         account_id: ${JSON.stringify(admin.account_id)},
         expected_version: ${order.version},
         reason: "record multibay membership fulfillment",
         source: "cli",
         idempotency_key: "multibay-record-" + ${JSON.stringify(randomUUID())},
         membership_package_ids: [${JSON.stringify(package_id)}],
       });
       return { fulfillment_state: result.fulfillment_state };`,
    );
    assert.equal(recorded.fulfillment_state, "provisioned");
  }

  it("records fulfillment on the seed from packages on the customer's home bay", async () => {
    const admin = await createAccount(cluster, {
      home_bay_id: SEED,
      name: "mira",
    });
    await makeAdmin(admin);
    await recordOnSeed({ admin, customer: bob });
  });

  it("reads the home bay when the acting admin is the customer, homed on the attached bay", async () => {
    const admin = await createAccount(cluster, {
      home_bay_id: ATTACHED,
      name: "nadia",
    });
    await makeAdmin(admin);
    await recordOnSeed({ admin, customer: admin });
  });
});

describe("admin credit attribution across bays", () => {
  // Admin balance adjustments are read and attributed on the seed (billing
  // authority), while the acting admin and the attributed admin may be homed
  // on another bay.
  it("lets an admin homed on the attached bay attribute a credit to another attached-bay admin", async () => {
    const actor = await createAccount(cluster, {
      home_bay_id: ATTACHED,
      name: "olga",
    });
    const attributed = await createAccount(cluster, {
      home_bay_id: ATTACHED,
      name: "petra",
    });
    for (const account of [actor, attributed]) {
      await runInBay(
        cluster,
        ATTACHED,
        `const getPool = require("@cocalc/database/pool").default;
         await getPool().query(
           "UPDATE accounts SET groups=ARRAY['admin'] WHERE account_id=$1",
           [${JSON.stringify(account.account_id)}]);`,
      );
    }
    const customer = await createAccount(cluster, {
      home_bay_id: SEED,
      name: "quinn",
    });
    const result = await runInBay(
      cluster,
      SEED,
      `const createCredit = server("purchases/create-credit.js").default;
       const purchase_id = await createCredit({
         account_id: ${JSON.stringify(customer.account_id)},
         amount: 24,
         tag: "admin-purchase",
         description: {
           description: "Admin balance adjustment",
           purpose: "admin-balance-adjustment",
         },
       });
       // Cluster-aware admin and account checks, as with the billing authority.
       process.env.COCALC_BILLING_AUTHORITY_ENABLED = "1";
       const attribution = server("purchases/admin-credit-attribution.js");
       const actor = ${JSON.stringify(actor.account_id)};
       const missing = await attribution.listAdminCreditAttribution({
         admin_account_id: actor,
         missing_only: true,
       });
       const attached = await attribution.attachAdminCreditAttribution({
         admin_account_id: actor,
         purchase_id,
         attributed_admin_account_id: ${JSON.stringify(attributed.account_id)},
         reason: "multibay attribution",
         commit: true,
       });
       return {
         purchase_id,
         missing: missing.map((row) => row.purchase_id),
         after: attached.after,
       };`,
      // Its own process: it switches on billing-authority mode.
      { fresh: true },
    );
    assert.ok(result.missing.includes(result.purchase_id));
    assert.equal(result.after.source, "attached");
    assert.equal(result.after.created_by, attributed.account_id);
    assert.equal(result.after.attached_by, actor.account_id);
  });
});

describe("EU/UK VAT refusal notice across bays", () => {
  // Automatic payments run on the seed (billing authority); the refused
  // customer may be homed on another bay and must get the notice there.
  it("delivers the off-session refusal notice from the seed to a customer homed on the attached bay", async () => {
    const result = await runInBay(
      cluster,
      SEED,
      `const { sendOffSessionRefusalNotice } = server("purchases/stripe/business-tax-id-gate.js");
       const first = await sendOffSessionRefusalNotice(${JSON.stringify(bob.account_id)});
       const second = await sendOffSessionRefusalNotice(${JSON.stringify(bob.account_id)});
       const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT target_home_bay_id FROM notification_target_outbox WHERE target_account_id=$1 AND kind='account_notice' ORDER BY created_at DESC LIMIT 1",
         [${JSON.stringify(bob.account_id)}]);
       return { first, second, target: rows[0]?.target_home_bay_id };`,
    );
    assert.equal(result.first, true);
    assert.equal(result.second, false);
    assert.equal(result.target, ATTACHED);
    const isThisNotice = (row) =>
      row.summary?.title === "Automatic payment not made: EU and UK customers";
    await eventually(
      async () =>
        (await bob.client.call("notifications.list", { limit: 50 })).some(
          isThisNotice,
        ),
      { timeoutMs: 60_000, what: "the VAT refusal notice to reach bob" },
    );
    const notices = (
      await bob.client.call("notifications.list", { limit: 50 })
    ).filter(isThisNotice);
    assert.equal(notices.length, 1);
  });
});

describe("outgoing support tickets across bays", () => {
  // Outreach settings, contact suppressions and the support mutation ledger
  // are seed-global: admin support create must run on the seed even when the
  // admin and the customer are homed on another bay.
  it("plans and commits on the seed for an admin and customer homed on the attached bay", async () => {
    const admin = await createAccount(cluster, {
      home_bay_id: ATTACHED,
      name: "sven",
    });
    await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       await getPool().query(
         "UPDATE accounts SET groups=ARRAY['admin'] WHERE account_id=$1",
         [${JSON.stringify(admin.account_id)}]);`,
    );
    // Seed-only configuration: the outreach Zendesk identity and a legal
    // suppression. (No Zendesk token, so a commit is rejected before sending.)
    await runInBay(
      cluster,
      SEED,
      `const getPool = require("@cocalc/database/pool").default;
       for (const [name, value] of [
         ["crm_outreach_zendesk_submitter_id", "4001"],
         ["crm_outreach_zendesk_group_id", "5002"],
         ["crm_outreach_zendesk_support_address", "help@multibay.example"],
       ]) {
         await getPool().query(
           "INSERT INTO server_settings (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value=EXCLUDED.value",
           [name, value]);
       }
       await getPool().query(
         "INSERT INTO crm_contact_suppressions (id, scope, normalized_scope_value, reason, source, active, created_at) VALUES (gen_random_uuid(), 'email', 'blocked@multibay.example', 'legal', 'cli', true, NOW())");`,
    );
    const request = {
      subject: "About your account",
      public_reply: "Hello, a short note from CoCalc support.",
      reason: "multibay outgoing ticket",
    };
    let plan;
    let lastError;
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
      try {
        plan = await runInBay(
          cluster,
          ATTACHED,
          `const support = server("conat/api/admin-support.js");
           return await support.planCreate({
             account_id: ${JSON.stringify(admin.account_id)},
             requester_account_id: ${JSON.stringify(bob.account_id)},
             ...${JSON.stringify(request)},
           });`,
        );
        break;
      } catch (err) {
        // The seed's settings cache may still be stale for a few seconds.
        lastError = err;
        await sleep(2_000);
      }
    }
    assert.ok(plan, `planning failed: ${lastError}`);
    assert.equal(plan.operation, "create");
    assert.equal(plan.requester.account_id, bob.account_id);
    assert.ok(plan.requester.email.includes("@"));

    const blocked = await runInBay(
      cluster,
      ATTACHED,
      `const support = server("conat/api/admin-support.js");
       try {
         await support.planCreate({
           account_id: ${JSON.stringify(admin.account_id)},
           requester_email: "blocked@multibay.example",
           ...${JSON.stringify(request)},
         });
         return "planned";
       } catch (err) {
         return String(err.message ?? err);
       }`,
    );
    assert.match(blocked, /is suppressed \(legal\)/);

    // The same commit, forwarded from the attached bay twice and run on the
    // seed directly, uses one seed ledger entry.
    const key = "multibay-support-create-" + Date.now();
    const commit = {
      ...request,
      requester_account_id: bob.account_id,
      payload_hash: plan.payload_hash,
      idempotency_key: key,
    };
    const errors = await runInBay(
      cluster,
      ATTACHED,
      `const { getInterBayBridge } = server("inter-bay/bridge.js");
       const errors = [];
       for (let i = 0; i < 2; i++) {
         try {
           await getInterBayBridge()
             .bayOps(${JSON.stringify(SEED)}, { timeout_ms: 60_000 })
             .crm({ action: "supportCreate",
                    actor_account_id: ${JSON.stringify(admin.account_id)},
                    payload: ${JSON.stringify(commit)} });
           errors.push("sent");
         } catch (err) {
           errors.push(String(err.message ?? err));
         }
       }
       return errors;`,
    );
    assert.equal(errors.length, 2);
    for (const error of errors) assert.match(error, /Zendesk token/);
    const ledger = await runInBay(
      cluster,
      SEED,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT status, account_id FROM admin_support_mutations WHERE idempotency_key=$1",
         [${JSON.stringify(key)}]);
       return rows;`,
    );
    assert.deepEqual(ledger, [
      { status: "rejected", account_id: admin.account_id },
    ]);
    const attachedLedger = await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT to_regclass('admin_support_mutations') IS NOT NULL AS exists");
       if (!rows[0].exists) return 0;
       const r = await getPool().query(
         "SELECT count(*)::int AS n FROM admin_support_mutations WHERE idempotency_key=$1",
         [${JSON.stringify(key)}]);
       return r.rows[0].n;`,
    );
    assert.equal(attachedLedger, 0);
  });
});

describe("billing exposure in admin health across bays", () => {
  // With central billing, purchases are authoritative only on the seed, and
  // each bay reports only the hosts it is responsible for (a rehomed host's
  // row stays behind in the source bay's database).
  const health = (bayId) =>
    runInBay(
      cluster,
      bayId,
      `process.env.COCALC_BILLING_AUTHORITY_ENABLED = "1";
       const { getConfiguredBayId } = server("bay-config.js");
       const { getBillingExposureHealth } = server(
         "purchases/billing-exposure-health.js");
       return await getBillingExposureHealth({ bay_id: getConfiguredBayId() });`,
      // Its own process: it switches on billing-authority mode. Loading the
      // server modules in a fresh process is slow on a busy runner.
      { fresh: true, timeoutMs: 120_000 },
    );

  async function insertStuckHost(bayId, { id, host_bay_id }) {
    await runInBay(
      cluster,
      bayId,
      `const getPool = require("@cocalc/database/pool").default;
       await getPool().query(
         \`INSERT INTO project_hosts (id,name,status,metadata,bay_id,created,updated)
          VALUES ($1,$2,'off',$3::jsonb,$4,NOW(),NOW())\`,
         [${JSON.stringify(id)}, "stuck-" + ${JSON.stringify(id)}.slice(0, 8),
          JSON.stringify({
            owner: ${JSON.stringify(randomUUID())},
            billing: {
              funding_mode: "account-prepaid",
              enforcement: {
                state: "stopped_billing_blocked",
                deprovision_after: new Date(Date.now() - 86400000).toISOString(),
                final_backup_status: "failed",
              },
            },
          }),
          ${JSON.stringify(host_bay_id)}]);`,
    );
  }

  it("reports balances only on the seed and hosts only on their own bay", async () => {
    const customer = await createAccount(cluster, {
      home_bay_id: ATTACHED,
      name: "rhea",
    });
    // The authoritative debt on the seed, and a stale non-authoritative row
    // in the attached bay's database that must not be reported there.
    for (const [bayId, cost] of [
      [SEED, 5000],
      [ATTACHED, 7000],
    ]) {
      await runInBay(
        cluster,
        bayId,
        `const getPool = require("@cocalc/database/pool").default;
         await getPool().query(
           \`INSERT INTO purchases (time,account_id,cost,service,description)
            VALUES (NOW(),$1,$2,'dedicated-host','{}'::jsonb)\`,
           [${JSON.stringify(customer.account_id)}, ${cost}]);`,
      );
    }
    const attachedHost = randomUUID();
    const residueOnSeed = randomUUID();
    await insertStuckHost(ATTACHED, {
      id: attachedHost,
      host_bay_id: ATTACHED,
    });
    // A host row left behind on the seed after a rehome to the attached bay.
    await insertStuckHost(SEED, { id: residueOnSeed, host_bay_id: ATTACHED });

    const seed = await health(SEED);
    assert.equal(seed.balances_checked_on_bay, undefined);
    assert.deepEqual(seed.negative.worst[0], {
      account_id: customer.account_id,
      balance: -5000,
    });
    assert.ok(
      !seed.stuck_hosts.some(({ host_id }) => host_id === residueOnSeed),
    );

    const attached = await health(ATTACHED);
    assert.equal(attached.balances_checked_on_bay, SEED);
    assert.equal(attached.negative.count, 0);
    assert.equal(attached.open_metered.count, 0);
    assert.ok(
      attached.stuck_hosts.some(({ host_id }) => host_id === attachedHost),
    );
  });
});

describe("public share views for a share stored off its project's bay", () => {
  // A legacy placement: the share's row is on the attached bay, while its
  // project (and so who is owner or collaborator) is on the seed.
  let dana; // homed on the seed, owns the project (alice is at her project limit)
  let carol; // homed on the seed, not in the project
  let project_id;
  const share_id = randomUUID();

  const viewsOn = async (bay) =>
    await runInBay(
      cluster,
      bay,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows: exists } = await getPool().query(
         "SELECT to_regclass('public_share_views') IS NOT NULL AS ok");
       if (!exists[0].ok) return [];
       const { rows } = await getPool().query(
         "SELECT account_id, viewer_role FROM public_share_views WHERE share_id=$1 ORDER BY viewer_role",
         [${JSON.stringify(share_id)}]);
       return rows;`,
    );

  before(async () => {
    dana = await createAccount(cluster, { home_bay_id: SEED, name: "dana" });
    dana.client = await client(dana);
    carol = await createAccount(cluster, { home_bay_id: SEED, name: "carol" });
    carol.client = await client(carol);
    project_id = await createProject(dana.client, "shared with views");
    assert.equal(await owningBay(project_id), SEED);
    await invite(dana, bob, project_id);
    await runInBay(
      cluster,
      ATTACHED,
      `await server("public-directory-shares/index.js").ensurePublicDirectorySharesSchema();
       const getPool = require("@cocalc/database/pool").default;
       await getPool().query(
         \`INSERT INTO public_project_paths (
            id, project_id, path, slug, visibility, requires_auth,
            availability_status, created_by, updated_by, disabled)
          VALUES ($1, $2, 'shared', $3, 'unlisted', TRUE, 'available', $4, $4, FALSE)\`,
         [${JSON.stringify(share_id)}, ${JSON.stringify(project_id)},
          ${JSON.stringify(`views-${share_id.slice(0, 8)}`)},
          ${JSON.stringify(dana.account_id)}]);`,
    );
  });

  it("records each read on the share's bay, with the role the project's bay has", async () => {
    for (const [name, viewer] of Object.entries({ dana, bob, carol })) {
      await eventually(
        async () =>
          (
            await viewer.client.call("publicDirectoryShares.authorizeRead", {
              project_id,
              share_id,
            })
          )?.share_id === share_id,
        { what: `${name} reading the share` },
      );
    }
    const rows = await eventually(
      async () => {
        const rows = await viewsOn(ATTACHED);
        return rows.length === 3 ? rows : undefined;
      },
      { what: "three views on the attached bay" },
    );
    assert.deepEqual(
      Object.fromEntries(rows.map((r) => [r.account_id, r.viewer_role])),
      {
        [dana.account_id]: "owner",
        [bob.account_id]: "collaborator",
        [carol.account_id]: "other",
      },
    );
    assert.deepEqual(await viewsOn(SEED), []);
  });

  it("reports the views to the project's owner and collaborator, from either bay, and to no one else", async () => {
    for (const viewer of [dana, bob]) {
      const views = await viewer.client.call("publicDirectoryShares.getViews", {
        project_id,
        share_id,
      });
      assert.deepEqual(views.distinct_viewers, {
        viewers: 3,
        owner: 1,
        collaborator: 1,
        other: 1,
      });
      assert.ok(!JSON.stringify(views).includes(carol.account_id));
    }
    await assert.rejects(
      carol.client.call("publicDirectoryShares.getViews", {
        project_id,
        share_id,
      }),
      /public directory share not found/,
    );
  });
});

describe("Sagebrush retention emails across a rehome", () => {
  // A retention cycle is kept on the bay that started it; a rehome leaves it
  // there (docs/sagebrush.md). That bay carries it on, asking the account's
  // new home bay for its state, and the new home's first check tells
  // Sagebrush what it already holds.
  const DAY = 24 * 60 * 60_000;
  let sage;
  let admin;

  // A fake Sagebrush and membership, for one snippet: the data is read-only,
  // to be deleted in 90 days, and sync is not in the membership.
  const fakes = `
    const purge_after = Date.now() + 90 * ${DAY};
    const notices = [];
    const fetch = async (url, init) => {
      const p = new URL(String(url)).pathname;
      if (p === "/api/admin/limits") {
        notices.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ applied: true }), { status: 200 });
      }
      const m = p.match(/^\\/api\\/admin\\/sync-retention\\/(.+)$/);
      if (m) {
        return new Response(JSON.stringify({ account_id: m[1], state: "readonly",
          readonly_since: Date.now() - ${DAY}, purge_after, now: Date.now() }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };
    const limits = { tier: "free", storage_bytes: 1000, max_file_bytes: 100,
      private_links: false, sync: { enabled: false, version_bytes: 10,
      read_bytes_per_day: 10, retention_days: 90 } };
    const getLimits = async () => limits;
    const config = { origin: "https://sagebrush.test", secret: "multibay" };
    const retention = require("@cocalc/server/sagebrush/sync-retention");`;

  it("rehomes an account with a retention email due on its old home bay", async () => {
    admin = await createAccount(cluster, { home_bay_id: SEED, name: "wren" });
    sage = await createAccount(cluster, { home_bay_id: SEED, name: "sage" });
    await runInBay(
      cluster,
      SEED,
      `const getPool = require("@cocalc/database/pool").default;
       await getPool().query(
         "UPDATE accounts SET groups=ARRAY['admin'] WHERE account_id=$1",
         [${JSON.stringify(admin.account_id)}]);
       // The membership ended and its notice was accepted: the first email is due.
       await getPool().query(
         \`INSERT INTO sagebrush_sync_states(account_id, sync_enabled, checked_at,
            changed_at, notice_accepted_at, email_stage, email_cycle, email_next_at,
            email_due_at, email_attempts)
          VALUES($1, false, NOW(), NOW(), NOW(), 'ended', gen_random_uuid(),
            NOW() - interval '1 minute', NOW(), 0)\`,
         [${JSON.stringify(sage.account_id)}]);`,
    );
    admin.client = await client(admin);
    // An admin's rehome needs a second factor: this session counts as one,
    // as a dev CLI sign-in does outside production.
    await runInBay(
      cluster,
      SEED,
      `const getPool = require("@cocalc/database/pool").default;
       await getPool().query(
         \`UPDATE account_auth_sessions
             SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"dev_cli_fresh_auth": true}'::jsonb
           WHERE account_id = $1\`,
         [${JSON.stringify(admin.account_id)}]);`,
    );
    const rehomed = await admin.client.call("system.rehomeAccount", {
      user_account_id: sage.account_id,
      dest_bay_id: ATTACHED,
      reason: "multibay sagebrush retention",
    });
    assert.equal(rehomed.status, "rehomed");
    assert.equal(rehomed.home_bay_id, ATTACHED);
    // The old home's own row now says the account moved.
    assert.equal(
      await runInBay(
        cluster,
        SEED,
        `const { getOAuthAccountStateLocal } = require("@cocalc/server/auth/oauth/account-state");
         return (await getOAuthAccountStateLocal({ account_id: ${JSON.stringify(sage.account_id)} })).state;`,
      ),
      "moved",
    );
  });

  it("sends the due email from the old home bay, asking the new home for the account", async () => {
    const r = await runInBay(
      cluster,
      SEED,
      `${fakes}
       const sent = [];
       const send = async (message) => { sent.push(message.to); };
       // The default accountState: routed through the directory to the new home.
       const counts = await retention.runDueRetentionSteps({ config, fetch, getLimits, send });
       const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT email_stage FROM sagebrush_sync_states WHERE account_id=$1",
         [${JSON.stringify(sage.account_id)}]);
       return { counts, sent, stage: rows[0]?.email_stage };`,
      { timeoutMs: 120_000 },
    );
    assert.deepEqual(r.counts, {
      sent: 1,
      cancelled: 0,
      failed: 0,
      stale: 0,
      unresolved: 0,
    });
    assert.deepEqual(r.sent, [sage.email_address]);
    assert.equal(r.stage, "before");
  });

  it("drops a notice left on the old home bay once the new home's membership no longer matches", async () => {
    // A notice ending sync, still pending on the seed when the account moves
    // and renews on its new home.
    const rowan = await createAccount(cluster, {
      home_bay_id: SEED,
      name: "rowan",
    });
    await runInBay(
      cluster,
      SEED,
      `const getPool = require("@cocalc/database/pool").default;
       await getPool().query(
         \`INSERT INTO sagebrush_sync_states(account_id, sync_enabled, checked_at,
            changed_at, notice_request_id, notice_issued, notice_limits,
            notice_attempts, notice_next_at)
          VALUES($1, false, NOW(), NOW(), gen_random_uuid(), $2, '{}'::jsonb, 0,
            NOW() + interval '1 hour')\`,
         [${JSON.stringify(rowan.account_id)}, Date.now()]);`,
    );
    const rehomed = await admin.client.call("system.rehomeAccount", {
      user_account_id: rowan.account_id,
      dest_bay_id: ATTACHED,
      reason: "multibay sagebrush retention",
    });
    assert.equal(rehomed.home_bay_id, ATTACHED);
    const r = await runInBay(
      cluster,
      SEED,
      `${fakes}
       const getPool = require("@cocalc/database/pool").default;
       await getPool().query(
         "UPDATE sagebrush_sync_states SET notice_next_at = NOW() - interval '1 minute' WHERE account_id=$1",
         [${JSON.stringify(rowan.account_id)}]);
       // Renewed on the new home (the default accountState asks it).
       limits.sync.enabled = true;
       const delivered = await retention.deliverDueSyncNotices({ config, fetch, getLimits });
       const { rows } = await getPool().query(
         "SELECT notice_next_at, notice_accepted_at, last_error FROM sagebrush_sync_states WHERE account_id=$1",
         [${JSON.stringify(rowan.account_id)}]);
       return { delivered, notices: notices.length, row: rows[0] };`,
      { timeoutMs: 120_000 },
    );
    assert.deepEqual(r.delivered, { accepted: 0, failed: 0 });
    assert.equal(r.notices, 0);
    assert.equal(r.row.notice_next_at, null);
    assert.equal(r.row.notice_accepted_at, null);
    assert.equal(r.row.last_error, "notice_superseded");
  });

  it("tells Sagebrush on the new home's first check that sync is back", async () => {
    const r = await runInBay(
      cluster,
      ATTACHED,
      `${fakes}
       const getPool = require("@cocalc/database/pool").default;
       // Approvals stay on the old home too: signing in again records one here.
       await getPool().query(
         \`INSERT INTO oauth_client_approvals(account_id, client_id, first_approved, last_approved)
          VALUES($1, 'sagebrush', NOW(), NOW())\`,
         [${JSON.stringify(sage.account_id)}]);
       // Renewed: the new home's first check sees sync on, while Sagebrush
       // still holds the data read-only.
       limits.sync.enabled = true;
       await retention.checkSyncStates({ config, fetch, getLimits });
       const delivered = await retention.deliverDueSyncNotices({ config, fetch, getLimits });
       const { rows } = await getPool().query(
         "SELECT sync_enabled, notice_accepted_at IS NOT NULL AS accepted, notice_next_at, last_error FROM sagebrush_sync_states WHERE account_id=$1",
         [${JSON.stringify(sage.account_id)}]);
       return { delivered, notices: notices.map((n) => [n.account_id, n.limits.sync.enabled]), row: rows[0] };`,
      { timeoutMs: 120_000 },
    );
    assert.deepEqual(r.notices, [[sage.account_id, true]], JSON.stringify(r));
    assert.equal(r.row.sync_enabled, true);
    assert.equal(r.row.accepted, true);
  });
});

describe("bay registry registration is bound to the calling bay", () => {
  // The attached bay, with its real fabric credential, tries to rewrite the
  // seed's registry entry. Both hops must refuse: the registry (bay_id must
  // equal source_bay_id) and the typed service layer (source_bay_id must be
  // the authenticated calling bay).
  async function registerFromAttached(request) {
    return await runInBay(
      cluster,
      ATTACHED,
      `const { getInterBayFabricClient } = server("inter-bay/fabric.js");
       const { createInterBayBayRegistryClient } = require("@cocalc/conat/inter-bay/api");
       const client = createInterBayBayRegistryClient({ client: getInterBayFabricClient() });
       try {
         await client.register(${JSON.stringify(request)});
         return "registered";
       } catch (err) {
         return String(err?.message ?? err);
       }`,
    );
  }

  async function seedEntry(bay_id) {
    return await runInBay(
      cluster,
      SEED,
      `const { listBayRegistryLocal } = server("bay-registry.js");
       const entry = (await listBayRegistryLocal()).find((e) => e.bay_id === ${JSON.stringify(bay_id)});
       return entry ? { label: entry.label, region: entry.region, role: entry.role, public_origin: entry.public_origin, public_target: entry.public_target } : null;`,
    );
  }

  it("refuses another bay's id under the caller's own source_bay_id", async () => {
    const before = await seedEntry(SEED);
    assert.ok(before, "the seed has a registry entry");
    assert.match(
      await registerFromAttached({
        bay_id: SEED,
        source_bay_id: ATTACHED,
        label: "hijacked",
        public_target: "attacker.example.com",
      }),
      /a bay may only register its own presence/,
    );
    assert.deepEqual(await seedEntry(SEED), before);
  });

  it("refuses a source_bay_id that is not the authenticated caller", async () => {
    const before = await seedEntry(SEED);
    assert.match(
      await registerFromAttached({
        bay_id: SEED,
        source_bay_id: SEED,
        label: "hijacked",
        public_target: "attacker.example.com",
      }),
      /source_bay_id must match authenticated bay/,
    );
    assert.deepEqual(await seedEntry(SEED), before);
  });

  it("still accepts the attached bay registering itself", async () => {
    const before = await seedEntry(ATTACHED);
    assert.ok(before, "the attached bay has a registry entry");
    const result = await registerFromAttached({
      bay_id: ATTACHED,
      source_bay_id: ATTACHED,
      label: before.label,
      region: before.region,
      role: before.role,
      public_origin: before.public_origin,
      public_target: before.public_target,
    });
    assert.equal(result, "registered");
    assert.deepEqual(await seedEntry(ATTACHED), before);
  });
});

describe("backup prune plans run on the seed, which owns the repositories", () => {
  // An admin homed on the attached bay asks for a read-only prune plan. Auth
  // is checked on the attached bay; the plan is forwarded over the real
  // inter-bay fabric and runs on the seed, which records it. The repository
  // exists only on the seed and has no usable bucket, so only the seed's
  // handler can produce the error the admin sees.
  let admin;
  const repo_id = randomUUID();

  const prunePlanLog = async (bay) =>
    await runInBay(
      cluster,
      bay,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT value FROM central_log WHERE event='project_backup_repo_prune_plan' AND value->>'repo_id'=$1",
         [${JSON.stringify(repo_id)}]);
       return rows.map((row) => row.value);`,
    );

  before(async () => {
    admin = await createAccount(cluster, {
      home_bay_id: ATTACHED,
      name: "pruner",
    });
    await runInBay(
      cluster,
      ATTACHED,
      `const getPool = require("@cocalc/database/pool").default;
       await getPool().query(
         "UPDATE accounts SET groups=ARRAY['admin'] WHERE account_id=$1",
         [${JSON.stringify(admin.account_id)}]);
       // The plan needs an admin with a second factor and a recent second
       // factor verification (the harness session is freshly verified).
       await getPool().query(
         "INSERT INTO account_second_factors (id, account_id, type, label, secret_encrypted, status, created, activated_at, metadata) VALUES (gen_random_uuid(), $1, 'totp', 'multibay test', 'unused', 'active', NOW(), NOW(), '{}'::jsonb)",
         [${JSON.stringify(admin.account_id)}]);`,
    );
    admin.client = await client(admin);
    await runInBay(
      cluster,
      SEED,
      `const { ensureProjectBackupRepoSchema } = server("project-backup/index.js");
       await ensureProjectBackupRepoSchema();
       const getPool = require("@cocalc/database/pool").default;
       await getPool().query(
         "INSERT INTO project_backup_repos (id, region, bucket_id, root, secret, status) VALUES ($1, 'wnam', $2, 'rustic/multibay-prune-plan', 'v1:unused', 'active')",
         [${JSON.stringify(repo_id)}, ${JSON.stringify(randomUUID())}]);`,
    );
  });

  it("forwards from the attached bay; the seed runs and records it", async () => {
    await assert.rejects(
      admin.client.call("system.getProjectBackupRepoPrunePlan", {
        repo_id,
        max_unused: "0",
      }),
      /no usable configuration/,
    );
    const seedLog = await prunePlanLog(SEED);
    assert.equal(seedLog.length, 1);
    assert.equal(seedLog[0].account_id, admin.account_id);
    assert.equal(seedLog[0].source_bay_id, ATTACHED);
    assert.equal(seedLog[0].bay_id, SEED);
    assert.equal(seedLog[0].max_unused, "0");
    assert.equal(seedLog[0].ok, false);
    assert.deepEqual(await prunePlanLog(ATTACHED), []);
  });

  it("reports a repository the seed does not have", async () => {
    await assert.rejects(
      admin.client.call("system.getProjectBackupRepoPrunePlan", {
        repo_id: randomUUID(),
      }),
      /no shared project backup repository/,
    );
  });

  it("refuses a non-admin before forwarding", async () => {
    await assert.rejects(
      bob.client.call("system.getProjectBackupRepoPrunePlan", { repo_id }),
      /must be an admin/,
    );
    assert.equal((await prunePlanLog(SEED)).length, 1);
  });
});
