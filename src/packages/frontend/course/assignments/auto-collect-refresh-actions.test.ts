/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let lroGet: jest.Mock;
let lroCancel: jest.Mock;
let collectAssignment: jest.Mock;

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
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  const students = ["s1", "s2", "s3", "s4"];
  const store = {
    get: (key: string) => (key === "course_project_id" ? "course" : undefined),
    get_student_ids: () => students,
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

// lro.get answers from the ops created so far.
function trackOps(initialStudents: string[]) {
  const ops = new Map<string, any>([
    [
      "op-old",
      {
        status: "queued",
        input: {
          items: initialStudents.map((student_id) => ({ student_id })),
        },
      },
    ],
  ]);
  let n = 0;
  lroGet = jest.fn(async ({ op_id }) => ops.get(op_id));
  lroCancel = jest.fn(async ({ op_id }) => {
    const op = ops.get(op_id);
    if (op) op.status = "canceled";
  });
  collectAssignment = jest.fn(async ({ items }) => {
    const op_id = `op-new-${++n}`;
    ops.set(op_id, { status: "queued", input: { items } });
    return { op_id };
  });
  return ops;
}

function scheduledStudents(call: any[]): string[] {
  return call[0].items.map((item: any) => item.student_id).sort();
}

describe("refreshing a scheduled collection after assigning", () => {
  it("merges overlapping completions into one replacement with every student", async () => {
    const { actions, record } = setup(["s1"]);
    const ops = trackOps(["s1"]);
    const firstGet = deferred<any>();
    lroGet = jest.fn(async ({ op_id }) =>
      op_id === "op-old" ? firstGet.promise : ops.get(op_id),
    );
    const a = actions.refresh_auto_collect(ASSIGNMENT, ["s2"]);
    const b = actions.refresh_auto_collect(ASSIGNMENT, ["s3"]);
    firstGet.resolve(ops.get("op-old"));
    await Promise.all([a, b]);

    expect(collectAssignment).toHaveBeenCalledTimes(1);
    expect(scheduledStudents(collectAssignment.mock.calls[0])).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
    expect(lroCancel.mock.calls.map(([x]) => x.op_id)).toEqual(["op-old"]);
    expect(record.auto_collect_op_id).toBe("op-new-1");
    expect(record.auto_collect_run_at).toBe(RUN_AT);
  });

  it("does nothing when the schedule already includes everyone", async () => {
    const { actions, record } = setup(["s1", "s2"]);
    trackOps(["s1", "s2"]);
    await actions.refresh_auto_collect(ASSIGNMENT, ["s2"]);
    expect(collectAssignment).not.toHaveBeenCalled();
    expect(record.auto_collect_op_id).toBe("op-old");
  });

  it("backs off when the instructor disables automatic collection meanwhile", async () => {
    const { actions, record } = setup(["s1"]);
    const ops = trackOps(["s1"]);
    lroGet = jest.fn(async ({ op_id }) => {
      record.auto_collect = false; // instructor turned it off during the read
      return ops.get(op_id);
    });
    await actions.refresh_auto_collect(ASSIGNMENT, ["s2"]);
    expect(collectAssignment).not.toHaveBeenCalled();
    expect(lroCancel).not.toHaveBeenCalled();
    expect(record.auto_collect).toBe(false);
  });

  it("discards its replacement when the instructor reschedules meanwhile", async () => {
    const { actions, record } = setup(["s1"]);
    trackOps(["s1"]);
    const create = collectAssignment;
    collectAssignment = jest.fn(async (opts) => {
      const op = await create(opts);
      // the instructor changed the due date while the replacement was created
      record.auto_collect_op_id = "op-instructor";
      record.auto_collect_run_at = "2026-12-01T00:00:00.000Z";
      return op;
    });
    await actions.refresh_auto_collect(ASSIGNMENT, ["s2"]);
    expect(lroCancel.mock.calls.map(([x]) => x.op_id)).toEqual(["op-new-1"]);
    expect(record.auto_collect_op_id).toBe("op-instructor");
    expect(record.auto_collect_run_at).toBe("2026-12-01T00:00:00.000Z");
  });

  it("keeps the existing schedule when the old one cannot be canceled", async () => {
    const { actions, record, errors } = setup(["s1"]);
    trackOps(["s1"]);
    lroCancel = jest.fn(async ({ op_id }) => {
      if (op_id === "op-old") throw Error("hub unavailable");
    });
    await actions.refresh_auto_collect(ASSIGNMENT, ["s2"]);
    expect(lroCancel.mock.calls.map(([x]) => x.op_id)).toEqual([
      "op-old",
      "op-new-1",
    ]);
    expect(record.auto_collect_op_id).toBe("op-old");
    expect(errors.join()).toContain("hub unavailable");
  });

  it("keeps the existing schedule when scheduling the replacement fails", async () => {
    const { actions, record, errors } = setup(["s1"]);
    trackOps(["s1"]);
    collectAssignment = jest.fn(async () => {
      throw Error("timeout");
    });
    await actions.refresh_auto_collect(ASSIGNMENT, ["s2"]);
    expect(lroCancel).not.toHaveBeenCalled();
    expect(record.auto_collect_op_id).toBe("op-old");
    expect(errors.join()).toContain("timeout");
  });
});
