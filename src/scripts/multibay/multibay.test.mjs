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
  async function deliverFromSeed({ project_id, forged = false }) {
    const report = {
      version: 1,
      report_id: randomUUID(),
      attempt_id: randomUUID(),
      turn_started_at: Date.now() - 60_000,
      kind: "error",
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
         source: { project_id, agent_id: ${JSON.stringify(randomUUID())} },
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

  async function countsFor(bay) {
    return await runInBay(
      cluster,
      bay,
      `const getPool = require("@cocalc/database/pool").default;
       const { rows } = await getPool().query(
         "SELECT kind, count(*)::int AS n FROM agent_sensor_events WHERE account_id=$1 GROUP BY kind ORDER BY kind",
         [${JSON.stringify(carol.account_id)}]);
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
      await onHome(
        "SELECT hash FROM remember_me WHERE hash = $1::CHAR(127)",
      ),
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
