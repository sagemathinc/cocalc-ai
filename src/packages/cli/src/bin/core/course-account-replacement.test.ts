import assert from "node:assert/strict";
import test from "node:test";
import {
  applyReplacement,
  replacementHash,
  validateReplacement,
  type ReplacementState,
  type ReplacementPorts,
} from "./course-account-replacement";

function fixture(): ReplacementState {
  return {
    course_project_id: "instructor-project",
    path: "class.course",
    student_id: "student",
    old_account_id: "old",
    new_account_id: "new",
    instructors: [{ account_id: "teacher", group: "owner" }],
    rows: [
      { table: "settings", shared_project_id: "shared" },
      {
        table: "students",
        student_id: "student",
        account_id: "old",
        project_id: "project",
        email_address: "school@example.edu",
      },
      { table: "grades", student_id: "student", grade: "A" },
    ],
    projects: [
      {
        project_id: "project",
        course: {
          type: "student",
          path: "class.course",
          project_id: "instructor-project",
          account_id: "old",
          required_membership_class: "student",
        },
        members: [
          { account_id: "old", group: "collaborator" },
          { account_id: "teacher", group: "owner" },
        ],
      },
      {
        project_id: "shared",
        course: {
          type: "shared",
          path: "class.course",
          project_id: "instructor-project",
        },
        members: [
          { account_id: "old", group: "collaborator" },
          { account_id: "teacher", group: "owner" },
        ],
      },
    ],
  };
}

function harness(state = fixture()) {
  const live = structuredClone(state),
    events: string[] = [];
  const ports: ReplacementPorts = {
    inspect: async () => structuredClone(live),
    checkpoint: async (phase) => {
      events.push(phase);
    },
    snapshot: async (id) => {
      events.push(`snapshot:${id}`);
    },
    add: async (id, account_id) => {
      events.push(`add:${id}`);
      live.projects
        .find((p) => p.project_id === id)!
        .members.push({ account_id, group: "collaborator" });
      live.projects.forEach((p) =>
        p.members.sort((a, b) => a.account_id.localeCompare(b.account_id)),
      );
    },
    setStudent: async (account_id) => {
      events.push("roster");
      live.rows.find((r) => r.table === "students")!.account_id = account_id;
    },
    setCourse: async (id, course) => {
      events.push("metadata");
      live.projects.find((p) => p.project_id === id)!.course = course;
    },
    remove: async (id, account_id) => {
      events.push(`remove:${id}`);
      const p = live.projects.find((p) => p.project_id === id)!;
      p.members = p.members.filter((m) => m.account_id !== account_id);
    },
  };
  return { state, live, events, ports };
}

test("preserves records and grants all new access before removing any old access", async () => {
  const h = harness();
  await applyReplacement(h.state, replacementHash(h.state), h.ports);
  assert.equal(h.live.rows[1].account_id, "new");
  assert.deepEqual(h.live.rows[2], h.state.rows[2]);
  assert.deepEqual(h.live.projects[1].course, h.state.projects[1].course);
  assert.ok(h.events.indexOf("add:shared") < h.events.indexOf("roster"));
  assert.ok(h.events.indexOf("metadata") < h.events.indexOf("remove:project"));
  for (const p of h.live.projects)
    assert.deepEqual(p.members, [
      { account_id: "new", group: "collaborator" },
      { account_id: "teacher", group: "owner" },
    ]);
  assert.equal(h.events.at(-1), "complete");
});

test("stale preview and changes during snapshots cannot change access", async () => {
  const h = harness();
  await assert.rejects(applyReplacement(h.state, "stale", h.ports), /stale/);
  assert.equal(h.events.length, 0);
  h.ports.snapshot = async () => {
    h.live.rows[2].grade = "B";
  };
  await assert.rejects(
    applyReplacement(h.state, replacementHash(h.state), h.ports),
    /changed during backup/,
  );
  assert.ok(!h.events.some((e) => e.startsWith("add:")));
});

test("duplicate, deleted, instructor, owner and mismatched project associations are rejected", () => {
  const cases: Array<(s: ReplacementState) => void> = [
    (s) => {
      s.rows.push({
        table: "students",
        student_id: "other",
        account_id: "new",
      });
    },
    (s) => {
      s.rows[1].deleted = true;
    },
    (s) => {
      s.instructors.push({ account_id: "old", group: "collaborator" });
    },
    (s) => {
      s.projects[0].members[0].group = "owner";
    },
    (s) => {
      s.projects[1].course.project_id = "other-course";
    },
    (s) => {
      s.projects[0].course.account_id = "someone-else";
    },
    (s) => {
      s.projects.pop();
    },
  ];
  for (const change of cases) {
    const s = fixture();
    change(s);
    assert.throws(() => validateReplacement(s));
  }
});

test("failed access grant or metadata save preserves old access and records phase", async () => {
  for (const failing of ["add", "setStudent", "setCourse"] as const) {
    const h = harness();
    h.ports[failing] = async () => {
      throw Error("remote failure");
    };
    await assert.rejects(
      applyReplacement(h.state, replacementHash(h.state), h.ports),
      /remote failure/,
    );
    assert.ok(!h.events.some((e) => e.startsWith("remove:")));
    assert.ok(
      h.live.projects.every((p) =>
        p.members.some((m) => m.account_id === "old"),
      ),
    );
  }
});

test("unexpected concurrent roster edits stop removal of old access", async () => {
  const h = harness();
  const set = h.ports.setCourse;
  h.ports.setCourse = async (...args) => {
    await set(...args);
    h.live.rows[2].grade = "B";
  };
  await assert.rejects(
    applyReplacement(h.state, replacementHash(h.state), h.ports),
    /Verification failed/,
  );
  assert.ok(!h.events.some((e) => e.startsWith("remove:")));
});
