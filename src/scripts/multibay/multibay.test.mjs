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
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { MultibayCluster } from "./cluster.mjs";
import {
  AccountClient,
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
  await rename(actor, project_id, title);
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
});
