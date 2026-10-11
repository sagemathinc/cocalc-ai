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
