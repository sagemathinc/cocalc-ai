/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let lroGet: jest.Mock;
let addStudents: jest.Mock;
let collectAssignment: jest.Mock;
let lroCancel: jest.Mock;

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        lro: {
          get: (...args: any[]) => lroGet(...args),
          cancel: (...args: any[]) => lroCancel(...args),
        },
      },
    },
    project_client: {
      addScheduledCollectionStudents: (...args: any[]) => addStudents(...args),
      collectAssignment: (...args: any[]) => collectAssignment(...args),
    },
  },
}));

import { fromJS } from "immutable";
import { AssignmentsActions } from "./actions";

const ASSIGNMENT = "a1";
const RUN_AT = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// A course with students s1..s4. `assignedInStore` are the students the
// (throttled) course store already shows as assigned.
function setup(assignedInStore: string[]) {
  const record: any = {
    table: "assignments",
    assignment_id: ASSIGNMENT,
    auto_collect: true,
    auto_collect_op_id: "op-old",
    auto_collect_run_at: RUN_AT,
  };
  const assignment = fromJS({
    assignment_id: ASSIGNMENT,
    title: "hw",
    target_path: "hw",
    collect_path: "hw-collect",
  });
  const store = {
    get: (key: string) => (key === "course_project_id" ? "course" : undefined),
    get_student_ids: () => ["s1", "s2", "s3", "s4"],
    last_copied: (step: string, _a: string, student_id: string) =>
      step === "assignment" && assignedInStore.includes(student_id)
        ? "done"
        : undefined,
    get_student_name_extra: (student_id: string) => ({ simple: student_id }),
  };
  const errors: string[] = [];
  const courseActions: any = {
    is_closed: () => false,
    resolve: ({ student_id }: { student_id?: string }) => ({
      store,
      assignment,
      student:
        student_id == null
          ? undefined
          : fromJS({
              project_id: `p-${student_id}`,
              account_id: `acct-${student_id}`,
            }),
    }),
    get_one: () => ({ ...record }),
    set: (obj: any) => Object.assign(record, obj),
    set_error: (err: string) => errors.push(err),
    student_projects: {
      ensure_course_manager_access: jest.fn(async () => undefined),
    },
  };
  const actions = new AssignmentsActions(courseActions);
  return { actions: actions as any, record, errors };
}

// The server side: a queued op whose items the server merges into, as
// addStudentsToScheduledCollection does.
function server(initialStudents: string[], status = "queued") {
  const op = {
    status,
    input: { items: initialStudents.map((student_id) => ({ student_id })) },
  };
  lroGet = jest.fn(async () => op);
  addStudents = jest.fn(async ({ items }) => {
    if (op.status !== "queued") return { updated: false };
    for (const item of items) {
      if (!op.input.items.some((x) => x.student_id === item.student_id)) {
        op.input.items.push(item);
      }
    }
    return { updated: true, item_count: op.input.items.length };
  });
  collectAssignment = jest.fn();
  lroCancel = jest.fn();
  return op;
}

const added = (call: any[]) =>
  call[0].items.map((item: any) => item.student_id).sort();

describe("adding later-assigned students to a scheduled collection", () => {
  it("merges overlapping completions into one update with every new student", async () => {
    const { actions, record } = setup(["s1"]);
    const op = server(["s1"]);
    const firstGet = deferred<any>();
    lroGet = jest
      .fn()
      .mockImplementationOnce(() => firstGet.promise)
      .mockImplementation(async () => op);
    const a = actions.refresh_auto_collect(ASSIGNMENT, ["s2"]);
    const b = actions.refresh_auto_collect(ASSIGNMENT, ["s3"]);
    firstGet.resolve(op);
    await Promise.all([a, b]);

    expect(addStudents).toHaveBeenCalledTimes(1);
    expect(addStudents.mock.calls[0][0]).toMatchObject({
      course_project_id: "course",
      assignment_id: ASSIGNMENT,
      op_id: "op-old",
    });
    expect(added(addStudents.mock.calls[0])).toEqual(["s2", "s3"]);
    expect(op.input.items.map((x) => x.student_id).sort()).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
    // the schedule is updated in place: no new operation, nothing canceled
    expect(collectAssignment).not.toHaveBeenCalled();
    expect(lroCancel).not.toHaveBeenCalled();
    expect(record.auto_collect_op_id).toBe("op-old");
  });

  it("does nothing when the schedule already includes everyone", async () => {
    const { actions } = setup(["s1", "s2"]);
    server(["s1", "s2"]);
    await actions.refresh_auto_collect(ASSIGNMENT, ["s2"]);
    expect(addStudents).not.toHaveBeenCalled();
  });

  it("does nothing when automatic collection is off", async () => {
    const { actions, record } = setup(["s1"]);
    server(["s1"]);
    record.auto_collect = false;
    await actions.refresh_auto_collect(ASSIGNMENT, ["s2"]);
    expect(lroGet).not.toHaveBeenCalled();
    expect(addStudents).not.toHaveBeenCalled();
  });

  it("leaves a collection that already started alone", async () => {
    const { actions } = setup(["s1"]);
    server(["s1"], "running");
    await actions.refresh_auto_collect(ASSIGNMENT, ["s2"]);
    expect(addStudents).not.toHaveBeenCalled();
  });

  it("is harmless when the collection stops being queued before the update", async () => {
    const { actions, errors } = setup(["s1"]);
    const op = server(["s1"]);
    lroGet = jest.fn(async () => {
      const snapshot = JSON.parse(JSON.stringify(op));
      op.status = "canceled"; // e.g. the instructor changed the due date
      return snapshot;
    });
    await actions.refresh_auto_collect(ASSIGNMENT, ["s2"]);
    expect(addStudents).toHaveBeenCalledTimes(1);
    expect(op.input.items.map((x) => x.student_id)).toEqual(["s1"]);
    expect(errors).toEqual([]);
  });

  it("reports a failed update without changing the schedule", async () => {
    const { actions, record, errors } = setup(["s1"]);
    server(["s1"]);
    addStudents = jest.fn(async () => {
      throw Error("timeout");
    });
    await actions.refresh_auto_collect(ASSIGNMENT, ["s2"]);
    expect(record.auto_collect_op_id).toBe("op-old");
    expect(errors.join()).toContain("timeout");
  });
});
