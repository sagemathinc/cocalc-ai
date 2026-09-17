import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCourseRootfsToManagedProjects,
  buildCourseReconfigureRequest,
  courseSettingsHash,
  courseRootfsProjectIds,
  readCourseRows,
  reconfigureCourseProjects,
  setCourseRootfs,
  summarizeCourseRows,
  type CourseSyncDB,
} from "./project-course";

function fakeCourse(rows: Record<string, any>[]) {
  const state = rows.map((row) => ({ ...row }));
  const commits: any[] = [];
  let saves = 0;
  let diskSaves = 0;
  const syncdb: CourseSyncDB = {
    wait_until_ready: async () => undefined,
    get: () => ({ toJS: () => state.map((row) => ({ ...row })) }),
    get_one: (where) => {
      const row = state.find((candidate) =>
        Object.entries(where).every(([key, value]) => candidate[key] === value),
      );
      return row ? { toJS: () => ({ ...row }) } : undefined;
    },
    set: (patch) => {
      const primaryKeys = [
        "table",
        "handout_id",
        "student_id",
        "assignment_id",
      ];
      const existing = state.find((candidate) =>
        primaryKeys.every(
          (key) =>
            candidate[key] === patch[key] ||
            (candidate[key] == null && patch[key] == null),
        ),
      );
      if (existing) Object.assign(existing, patch);
      else state.push({ ...patch });
    },
    commit: (opts) => {
      commits.push(opts);
      return true;
    },
    save: async () => {
      saves += 1;
    },
    save_to_disk: async () => {
      diskSaves += 1;
    },
    close: async () => undefined,
  };
  return {
    syncdb,
    rows: state,
    commits,
    get saves() {
      return saves;
    },
    get diskSaves() {
      return diskSaves;
    },
  };
}

test("course settings hashes and summaries are deterministic", () => {
  const first = courseSettingsHash({
    table: "settings",
    b: 2,
    a: { y: 2, x: 1 },
  });
  const second = courseSettingsHash({
    a: { x: 1, y: 2 },
    b: 2,
    table: "settings",
  });
  assert.equal(first, second);

  const summary = summarizeCourseRows({
    project_id: "course-project",
    path: "Fall/math.course",
    rows: [
      {
        table: "settings",
        student_project_rootfs_image: "rootfs/image",
        student_project_rootfs_image_id: "image-id",
        shared_project_id: "shared-project",
      },
      {
        table: "students",
        student_id: "student-1",
        project_id: "student-project",
      },
      { table: "students", student_id: "student-2", deleted: true },
    ],
  });
  assert.deepEqual(summary.rootfs, {
    image: "rootfs/image",
    image_id: "image-id",
  });
  assert.deepEqual(summary.students, {
    total: 2,
    active: 1,
    deleted: 1,
    with_project: 1,
  });
  assert.deepEqual(summary.managed_project_ids, [
    "shared-project",
    "student-project",
  ]);
});

test("course RootFS projects exclude deleted, instructor, and nbgrader projects", () => {
  assert.deepEqual(
    courseRootfsProjectIds({
      course_project_id: "course-project",
      rows: [
        {
          table: "settings",
          shared_project_id: "shared-project",
          nbgrader_grade_project: "nbgrader-project",
        },
        {
          table: "students",
          student_id: "student-1",
          project_id: "student-project",
        },
        {
          table: "students",
          student_id: "student-2",
          project_id: "deleted-project",
          deleted: true,
        },
        {
          table: "students",
          student_id: "student-3",
          project_id: "shared-project",
        },
        {
          table: "students",
          student_id: "student-4",
          project_id: "course-project",
        },
      ],
    }),
    ["shared-project", "student-project"],
  );
});

test("applying a course RootFS mutates every managed project and restarts active ones", async () => {
  const calls: any[] = [];
  const result = await applyCourseRootfsToManagedProjects({
    hub: {
      system: {
        setProjectRootfsImage: async (opts) => {
          calls.push(["set-rootfs", opts]);
          return [{ state_role: "current", runtime_image: opts.image }];
        },
      },
      projects: {
        getProjectState: async ({ project_id }) => {
          calls.push(["state", project_id]);
          return {
            state: project_id === "student-project" ? "running" : "stopped",
          };
        },
        restart: async (opts) => {
          const { restart_request_id, ...rest } = opts;
          assert.match(
            restart_request_id,
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          );
          calls.push(["restart", rest]);
          return { op_id: `restart-${opts.project_id}` };
        },
      },
    } as any,
    course_project_id: "course-project",
    rows: [
      {
        table: "settings",
        student_project_rootfs_image: "rootfs/image",
        student_project_rootfs_image_id: "image-id",
        shared_project_id: "shared-project",
      },
      {
        table: "students",
        student_id: "student-1",
        project_id: "student-project",
      },
    ],
  });

  assert.deepEqual(calls, [
    ["state", "shared-project"],
    ["state", "student-project"],
    [
      "set-rootfs",
      {
        project_id: "shared-project",
        image: "rootfs/image",
        image_id: "image-id",
      },
    ],
    [
      "set-rootfs",
      {
        project_id: "student-project",
        image: "rootfs/image",
        image_id: "image-id",
      },
    ],
    ["restart", { project_id: "student-project", wait: true }],
  ]);
  assert.equal(result.project_count, 2);
  assert.equal(result.restarted_count, 1);
});

test("applying a course RootFS preflights every project before mutating", async () => {
  const calls: any[] = [];
  await assert.rejects(
    applyCourseRootfsToManagedProjects({
      hub: {
        system: {
          setProjectRootfsImage: async (opts) => {
            calls.push(["set-rootfs", opts.project_id]);
            return [];
          },
        },
        projects: {
          getProjectState: async ({ project_id }) => {
            calls.push(["state", project_id]);
            if (project_id === "student-project") {
              throw new Error("project access denied");
            }
            return { state: "stopped" };
          },
          restart: async () => {
            throw new Error("unexpected restart");
          },
        },
      } as any,
      course_project_id: "course-project",
      rows: [
        {
          table: "settings",
          student_project_rootfs_image: "rootfs/image",
          shared_project_id: "shared-project",
        },
        {
          table: "students",
          student_id: "student-1",
          project_id: "student-project",
        },
      ],
    }),
    /project access denied/,
  );

  assert.deepEqual(calls, [
    ["state", "shared-project"],
    ["state", "student-project"],
  ]);
});

test("setCourseRootfs checks the inspected hash and records audit metadata", async () => {
  const course = fakeCourse([
    {
      table: "settings",
      title: "Math",
      student_project_rootfs_image: "old-image",
      student_project_rootfs_image_id: "old-id",
    },
  ]);
  const beforeHash = courseSettingsHash(course.rows[0]);
  const result = await setCourseRootfs({
    syncdb: course.syncdb,
    project_id: "course-project",
    path: "math.course",
    image: "new-image",
    image_id: "new-id",
    expected_settings_hash: beforeHash,
    account_id: "operator",
  });

  assert.deepEqual(result.after, { image: "new-image", image_id: "new-id" });
  assert.equal(course.saves, 1);
  assert.equal(course.diskSaves, 1);
  assert.deepEqual(course.commits[0].meta, {
    action: "cli.course.config.set-rootfs",
    project_id: "course-project",
    course_path: "math.course",
    account_id: "operator",
    previous_image: "old-image",
    previous_image_id: "old-id",
    image: "new-image",
    image_id: "new-id",
  });

  await assert.rejects(
    setCourseRootfs({
      syncdb: course.syncdb,
      project_id: "course-project",
      path: "math.course",
      image: "other-image",
      expected_settings_hash: beforeHash,
    }),
    /course settings changed/,
  );
});

test("course reconfiguration request preserves settings without sending email", async () => {
  const request = await buildCourseReconfigureRequest({
    hub: {
      projects: {
        getProjectEnv: async () => ({ TOKEN: 123 }),
      },
    } as any,
    project_id: "course-project",
    path: "courses/math.course",
    rows: [
      {
        table: "settings",
        title: "Math 101.course",
        allow_collabs: false,
        datastore: ["/data"],
        envvars: { inherit: true },
        require_invite_email_match: true,
        student_project_rootfs_image: "rootfs-image",
        student_project_rootfs_image_id: "rootfs-id",
      },
      {
        table: "students",
        student_id: "student-1",
        display_name: "Ada Lovelace",
        email_address: "ada@example.com",
      },
      {
        table: "students",
        student_id: "student-2",
        deleted: true,
      },
    ],
  });

  assert.equal(request.settings.allow_collabs, false);
  assert.deepEqual(request.settings.datastore, ["/data"]);
  assert.deepEqual(request.settings.inherited_env, { TOKEN: "123" });
  assert.equal(request.settings.require_invite_email_match, true);
  assert.equal(request.settings.student_project_rootfs_image, "rootfs-image");
  assert.deepEqual(request.students, [
    {
      student_id: "student-1",
      name: "Ada Lovelace",
      project_id: undefined,
      account_id: undefined,
      email_address: "ada@example.com",
      deleted: false,
      send_email_invite: false,
    },
  ]);
});

test("reconfigureCourseProjects waits and persists created student projects", async () => {
  const course = fakeCourse([
    { table: "settings", title: "Math", allow_collabs: true },
    {
      table: "students",
      student_id: "student-1",
      display_name: "Ada Lovelace",
    },
  ]);
  let submitted: any;
  const result = await reconfigureCourseProjects({
    hub: {
      projects: {
        getProjectEnv: async () => undefined,
        reconfigureCourseProjects: async (request) => {
          submitted = request;
          return {
            op_id: "operation-1",
            scope_type: "project",
            scope_id: "course-project",
            service: "course-reconfigure",
            stream_name: "stream",
            requested_snapshot_hash: "snapshot",
            operation_snapshot_hash: "snapshot",
          };
        },
        getCourseReconfigureOperation: async () => ({
          op_id: "operation-1",
          status: "succeeded",
          result: {
            items: [
              {
                key: "student:student-1",
                type: "student",
                student_id: "student-1",
                project_id: "student-project",
                status: "done",
                created: true,
              },
            ],
          },
          progress_summary: { total: 1, done: 1 },
          error: null,
        }),
      },
    } as any,
    syncdb: course.syncdb,
    project_id: "course-project",
    path: "math.course",
    account_id: "operator",
    timeout_ms: 10_000,
    poll_ms: 1,
  });

  assert.equal(submitted.students[0].send_email_invite, false);
  assert.equal(course.rows[1].project_id, "student-project");
  assert.equal(result.status, "succeeded");
  assert.equal(result.op_id, "operation-1");
  assert.deepEqual(course.commits.at(-1).meta, {
    action: "cli.course.reconfigure.apply-result",
    project_id: "course-project",
    course_path: "math.course",
    account_id: "operator",
    op_id: "operation-1",
  });
  assert.equal(readCourseRows(course.syncdb)[1].project_id, "student-project");
});
