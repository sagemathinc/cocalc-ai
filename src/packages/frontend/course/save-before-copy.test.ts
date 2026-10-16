/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Copies to students read files as saved on disk, so every entry point that
// copies course files out to students (assign, handouts, return, peer) must save the course project's open files first, and copy
// nothing if that fails.

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    project_client: {},
    conat_client: { hub: {} },
    server_time: () => new Date(),
  },
}));

import { CourseActions } from "./actions";
import { AssignmentsActions } from "./assignments/actions";
import { HandoutsActions } from "./handouts/actions";

const COURSE_PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("CourseActions.save_course_project_files", () => {
  function setup(save_all_files: jest.Mock) {
    const getProjectActions = jest.fn(() => ({ save_all_files }));
    const actions = new CourseActions("course", {
      getStore: jest.fn(),
      getProjectActions,
    } as any);
    const errors: string[] = [];
    (actions as any).get_store = () => ({
      get: (key: string) =>
        key === "course_project_id" ? COURSE_PROJECT_ID : undefined,
    });
    (actions as any).set_error = (err: string) => errors.push(err);
    return { actions, getProjectActions, errors };
  }

  it("saves every open file in the course project", async () => {
    const save_all_files = jest.fn(async () => undefined);
    const { actions, getProjectActions, errors } = setup(save_all_files);
    await expect(actions.save_course_project_files()).resolves.toBe(true);
    expect(getProjectActions).toHaveBeenCalledWith(COURSE_PROJECT_ID);
    expect(save_all_files).toHaveBeenCalledTimes(1);
    expect(save_all_files).toHaveBeenCalledWith({ strict: true });
    expect(errors).toEqual([]);
  });

  it("reports a failed save and returns false", async () => {
    const save_all_files = jest.fn(async () => {
      throw Error("disk full");
    });
    const { actions, errors } = setup(save_all_files);
    await expect(actions.save_course_project_files()).resolves.toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Nothing was copied to students");
    expect(errors[0]).toContain("disk full");
  });
});

describe("assign and handout copies save open files first", () => {
  function setup(saved: boolean) {
    const events: string[] = [];
    const courseActions: any = {
      save_course_project_files: jest.fn(async () => {
        events.push("save");
        return saved;
      }),
      is_closed: () => true, // stop right after the first step
      resolve: jest.fn(() => {
        events.push("resolve");
        return {};
      }),
      set_activity: jest.fn(() => {
        events.push("activity");
        return "activity";
      }),
      clear_activity: () => undefined,
      set_error: jest.fn(),
      get_store: () => ({ get: () => undefined }),
    };
    const assignments: any = new AssignmentsActions(courseActions);
    assignments.update_listing = jest.fn(async () => {
      events.push("update_listing");
    });
    for (const name of [
      "copy_assignment_to_student",
      "return_assignment_to_student",
      "peer_copy_to_student",
      "assignment_action_all_students",
    ]) {
      assignments[name] = jest.fn(async () => {
        events.push("copy");
      });
    }
    assignments.update_peer_assignment = jest.fn(() => {
      events.push("update_peer");
    });
    const handouts: any = new HandoutsActions(courseActions);
    handouts.handout_start_copy = jest.fn(() => {
      events.push("start_copy");
      return true;
    });
    return { assignments, handouts, events, courseActions };
  }

  const entryPoints: [string, (x: any) => Promise<void>, string][] = [
    [
      "assigning to one student",
      ({ assignments }) => assignments.copy_assignment("assigned", "a1", "s1"),
      "update_listing",
    ],
    [
      "assigning to all students",
      ({ assignments }) =>
        assignments.copy_assignment_to_all_students("a1", false, false),
      "update_listing",
    ],
    [
      "sending selected assignment files",
      ({ assignments }) =>
        assignments.send_selected_assignment_paths_to_students({
          assignment_id: "a1",
          relative_paths: ["hw.ipynb"],
        }),
      "update_listing",
    ],
    [
      "returning graded work to one student",
      ({ assignments }) => assignments.copy_assignment("graded", "a1", "s1"),
      "copy",
    ],
    [
      "returning graded work to all students",
      ({ assignments }) =>
        assignments.return_assignment_to_all_students("a1", false),
      "activity",
    ],
    [
      "peer-assigning to one student",
      ({ assignments }) =>
        assignments.copy_assignment("peer-assigned", "a1", "s1"),
      "copy",
    ],
    [
      "peer-assigning to all students",
      ({ assignments }) => assignments.peer_copy_to_all_students("a1", false),
      "update_peer",
    ],
    [
      "copying a handout to one student",
      ({ handouts }) => handouts.copy_handout_to_student("h1", "s1", false),
      "start_copy",
    ],
    [
      "copying a handout to all students",
      ({ handouts }) =>
        handouts.copy_handout_to_all_students("h1", false, false),
      "activity",
    ],
  ];

  it.each(entryPoints)("%s saves before copying", async (_, run, next) => {
    const x = setup(true);
    await run(x);
    expect(x.events[0]).toBe("save");
    expect(x.events[1]).toBe(next);
  });

  it.each(entryPoints)(
    "%s copies nothing when the save fails",
    async (_, run) => {
      const x = setup(false);
      await run(x);
      expect(x.events).toEqual(["save"]);
    },
  );
});

describe("collecting from students does not save", () => {
  it.each(["collected", "peer-collected"])("%s", async (type) => {
    const save_course_project_files = jest.fn(async () => true);
    const assignments: any = new AssignmentsActions({
      save_course_project_files,
    } as any);
    assignments.copy_assignment_from_student = jest.fn(async () => undefined);
    assignments.peer_collect_from_student = jest.fn(async () => undefined);
    await assignments.copy_assignment(type, "a1", "s1");
    expect(save_course_project_files).not.toHaveBeenCalled();
  });
});
