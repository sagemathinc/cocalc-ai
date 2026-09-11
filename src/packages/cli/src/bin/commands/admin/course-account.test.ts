import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerCourseAccountSupportCommand } from "./course-account";

const teacher = "11111111-1111-4111-8111-111111111111",
  old = "22222222-2222-4222-8222-222222222222",
  next = "33333333-3333-4333-8333-333333333333";
const courseProject = "44444444-4444-4444-8444-444444444444",
  project = "55555555-5555-4555-8555-555555555555",
  student = "66666666-6666-4666-8666-666666666666";

function setup(t: any, remoteBay = false) {
  let output: any,
    calls: string[] = [];
  let rows: any[] = [
    { table: "settings" },
    {
      table: "students",
      student_id: student,
      project_id: project,
      account_id: old,
    },
    { table: "grades", student_id: student, grade: 95 },
  ];
  let metadata: any = {
    type: "student",
    project_id: courseProject,
    path: "class.course",
    account_id: old,
  };
  let members = [
    { account_id: old, group: "collaborator" },
    { account_id: teacher, group: "owner" },
  ];
  const db = {
    wait_until_ready: async () => {},
    get: () => structuredClone(rows),
    set: (patch: any) => {
      calls.push("roster");
      rows = rows.map((r) =>
        r.table === patch.table && r.student_id === patch.student_id
          ? { ...r, ...patch }
          : r,
      );
    },
    commit: () => true,
    save: async () => {},
    save_to_disk: async () => {},
    close: async () => {
      calls.push("close-doc");
    },
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (input: any, init: any) => {
    const path = new URL(input).pathname;
    if (path === "/auth/impersonate") {
      assert.equal(init.headers, undefined);
      calls.push("consume-grant");
      return new Response("", {
        headers: { "set-cookie": "remember_me=temporary; HttpOnly" },
      });
    }
    assert.equal(init.headers.Cookie, "remember_me=temporary");
    if (path.endsWith("sign-out")) {
      assert.deepEqual(JSON.parse(init.body), { all: false });
      calls.push("sign-out");
    } else if (path.endsWith("set-course-info")) {
      calls.push("metadata");
      metadata = JSON.parse(init.body).course;
    } else throw Error("Unexpected HTTP call");
    return Response.json({ ok: true });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const ctx = {
    accountId: teacher,
    remote: { user: { account_id: teacher } },
    hub: {
      system: {
        getProjectBay: async () => ({
          owning_bay_id: remoteBay ? "other" : "bay-0",
        }),
      },
      projects: {
        listCollaborators: async ({ project_id }: any) =>
          structuredClone(
            project_id === courseProject
              ? [{ account_id: teacher, group: "owner" }]
              : members,
          ),
        getProjectCourseInfo: async () => structuredClone(metadata),
        createSnapshot: async () => {
          calls.push("snapshot");
        },
        removeCollaborator: async ({ opts }: any) => {
          calls.push("remove");
          members = members.filter((m) => m.account_id !== opts.account_id);
        },
      },
    },
  };
  const deps: any = {
    isValidUUID: (id: string) => /^[a-f0-9-]{36}$/.test(id),
    withContext: async (_c: any, _n: any, fn: any) => {
      output = await fn({
        apiBaseUrl: "https://site.test",
        accountId: "admin",
        hub: {
          adminDb: {
            query: async (opts: any) => {
              assert.equal(opts.bay_id, "bay-0");
              assert.match(opts.sql, /SELECT owning_bay_id, deleted/);
              return {
                bay_id: "bay-0",
                rows: [[remoteBay ? "other" : "bay-0", false]],
              };
            },
          },
          system: {
            userSearch: async ({ query }: any) => [
              {
                account_id: query,
                email_address: query + "@example.edu",
                email_address_verified: true,
              },
            ],
            createImpersonationGrant: async (p: any) => {
              assert.equal(p.subject_account_id, teacher);
              assert.equal(p.support_ticket_id, 123);
              calls.push("grant");
              return {
                url: "https://site.test/auth/impersonate?grant_id=opaque",
                subject_home_bay_id: "bay-0",
              };
            },
          },
          projects: {
            createCollabInvite: async (p: any) => {
              assert.equal(p.direct, true);
              calls.push("add");
              members.push({
                account_id: p.invitee_account_id,
                group: "collaborator",
              });
            },
          },
        },
      });
    },
    contextForGlobals: async (g: any) => {
      assert.equal(g.profile, "_env");
      assert.equal(g.disableEnvAuthDefaults, true);
      return ctx;
    },
    closeCommandContext: async () => {
      calls.push("close-context");
    },
    resolveProjectConatClient: async () => ({
      client: { sync: { db: () => db } },
    }),
    resolveProjectFilesystem: async () => ({
      fs: { stat: async () => ({ isFile: () => true }) },
    }),
  };
  const run = async (extra: string[] = []) => {
    const command = new Command();
    registerCourseAccountSupportCommand(command, deps);
    await command.parseAsync([
      "node",
      "test",
      "replace-course-student-account",
      "--ticket-id",
      "123",
      "--instructor",
      teacher,
      "--project",
      courseProject,
      "--path",
      "class.course",
      "--student-id",
      student,
      "--old-account",
      old,
      "--new-account",
      next,
      "--reason",
      "Approved repair",
      "--consent-reference",
      "Instructor and operator confirmed",
      ...extra,
    ]);
    return output;
  };
  return {
    run,
    calls,
    get rows() {
      return rows;
    },
    get members() {
      return members;
    },
  };
}

test("preview reads live state, isolates credentials, and revokes its session without edits", async (t) => {
  const h = setup(t);
  const result = await h.run();
  assert.equal(result.commit, false);
  assert.match(result.state_hash, /^sha256:/);
  assert.ok(
    !h.calls.some((x) =>
      ["snapshot", "add", "roster", "metadata", "remove"].includes(x),
    ),
  );
  assert.equal(h.calls.at(-1), "sign-out");
});

test("cross-bay preflight fails and still revokes the temporary session", async (t) => {
  const h = setup(t, true);
  await assert.rejects(h.run(), /Cross-bay/);
  assert.equal(h.calls.at(-1), "sign-out");
  assert.ok(!h.calls.includes("add"));
});

test("commit persists private recovery state and completes the existing API workflow", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "course-account-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = setup(t),
    preview = await h.run(),
    recovery = join(dir, "repair");
  const result = await h.run([
    "--commit",
    "--expected-hash",
    preview.state_hash,
    "--recovery-dir",
    recovery,
  ]);
  assert.equal(result.commit, true);
  assert.equal(h.rows[1].account_id, next);
  assert.equal(h.rows[2].grade, 95);
  assert.ok(h.members.some((m) => m.account_id === next));
  assert.ok(!h.members.some((m) => m.account_id === old));
  const before = JSON.parse(
    await readFile(join(recovery, "before.json"), "utf8"),
  );
  assert.equal(before.state.rows[1].account_id, old);
  assert.equal((await stat(recovery)).mode & 0o777, 0o700);
  assert.equal((await stat(join(recovery, "before.json"))).mode & 0o777, 0o600);
  const events = (await readFile(join(recovery, "progress.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  assert.equal(events.at(-1).phase, "complete");
  assert.equal(h.calls.at(-1), "sign-out");
});
