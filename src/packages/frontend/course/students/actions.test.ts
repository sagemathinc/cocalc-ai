/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

let currentAccountId = "11111111-1111-4111-8111-111111111111";
let userSearchMock: jest.Mock;

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    get account_id() {
      return currentAccountId;
    },
    users_client: {
      user_search: (...args: any[]) => userSearchMock(...args),
    },
  },
}));

import { Map as iMap } from "immutable";

import { StudentsActions } from "./actions";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve0) => {
    resolve = resolve0;
  });
  return { promise, resolve };
}

describe("StudentsActions.add_students", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    currentAccountId = "11111111-1111-4111-8111-111111111111";
    userSearchMock = jest.fn(async () => []);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function reduxWithCourseManagers({
    email = "teacher@example.com",
    managers = {},
  }: {
    email?: string;
    managers?: Record<string, { group: string }>;
  } = {}) {
    return {
      getStore: (name: string) => {
        if (name === "account") {
          return { get_email_address: () => email };
        }
        if (name === "projects") {
          return {
            get_users: () => ({
              forEach: (fn) =>
                Object.entries(managers).forEach(([accountId, info]) =>
                  fn(info, accountId),
                ),
            }),
          };
        }
      },
    };
  }

  it("waits for complete project creation before the final configuration pass", async () => {
    const creationStarted = deferred();
    const finishCreation = deferred<string>();
    let projectId: string | undefined;
    const createStudentProject = jest.fn(async () => {
      creationStarted.resolve();
      projectId = await finishCreation.promise;
      return projectId;
    });
    const configureAllProjects = jest.fn(async () => undefined);
    const store = {
      get: (key: string) =>
        key === "course_project_id" ? "course-project" : undefined,
      get_copy_parallel: () => 1,
      get_student: () => ({}),
      getIn: () => projectId,
      wait: (opts) => opts.cb(undefined, opts.until(store)),
    };
    const courseActions = {
      commit: jest.fn(),
      get_store: () => store,
      is_closed: () => false,
      set: jest.fn(),
      set_activity: () => 1,
      set_error: jest.fn(),
      redux: reduxWithCourseManagers(),
      student_projects: {
        configure_all_projects: configureAllProjects,
        create_student_project: createStudentProject,
      },
      syncdb: {
        commit: jest.fn(),
        get_state: () => "ready",
        set: jest.fn(),
        wait_until_ready: jest.fn(async () => undefined),
      },
    };
    const actions = new StudentsActions(courseActions as any);

    const addingStudents = actions.add_students([
      { email_address: "student@example.com" },
    ]);
    await creationStarted.promise;

    expect(configureAllProjects).not.toHaveBeenCalled();

    finishCreation.resolve("11111111-1111-4111-8111-111111111111");
    await addingStudents;

    expect(createStudentProject).toHaveBeenCalledTimes(1);
    expect(configureAllProjects).toHaveBeenCalledTimes(1);
  });

  it("waits for the course document before writing student records", async () => {
    const ready = deferred();
    const syncdb = {
      commit: jest.fn(),
      get_state: () => "init",
      set: jest.fn(),
      wait_until_ready: jest.fn(() => ready.promise),
    };
    const store = {
      get: (key: string) =>
        key === "course_project_id" ? "course-project" : undefined,
      get_copy_parallel: () => 1,
      get_student: () => ({}),
      getIn: () => "11111111-1111-4111-8111-111111111111",
      wait: (opts) => opts.cb(undefined, opts.until(store)),
    };
    const courseActions = {
      commit: jest.fn(),
      get_store: () => store,
      is_closed: () => false,
      set: jest.fn(),
      set_activity: () => 1,
      set_error: jest.fn(),
      redux: reduxWithCourseManagers(),
      student_projects: {
        configure_all_projects: jest.fn(async () => undefined),
        create_student_project: jest.fn(async () => undefined),
      },
      syncdb,
    };
    const actions = new StudentsActions(courseActions as any);

    const addingStudents = actions.add_students([
      { email_address: "student@example.com" },
    ]);
    await Promise.resolve();

    expect(syncdb.wait_until_ready).toHaveBeenCalledTimes(1);
    expect(courseActions.set).not.toHaveBeenCalled();
    expect(courseActions.commit).not.toHaveBeenCalled();

    ready.resolve();
    await addingStudents;

    expect(courseActions.set).toHaveBeenCalledTimes(1);
    expect(courseActions.commit).toHaveBeenCalledTimes(1);
  });

  it("rejects the current manager email before writing the course document", async () => {
    const store = {
      get: (key: string) =>
        key === "course_project_id" ? "course-project" : undefined,
    };
    const courseActions = {
      commit: jest.fn(),
      get_store: () => store,
      redux: reduxWithCourseManagers({
        managers: { [currentAccountId]: { group: "owner" } },
      }),
      set: jest.fn(),
      syncdb: { wait_until_ready: jest.fn(async () => undefined) },
    };
    const actions = new StudentsActions(courseActions as any);

    await expect(
      actions.add_students([{ email_address: "teacher@example.com" }]),
    ).rejects.toThrow(
      "create a separate CoCalc account, for example teacher+1@example.com",
    );
    expect(courseActions.set).not.toHaveBeenCalled();
    expect(courseActions.commit).not.toHaveBeenCalled();
    expect(userSearchMock).not.toHaveBeenCalled();
  });

  it("rejects an email that resolves to another course manager", async () => {
    const managerAccountId = "22222222-2222-4222-8222-222222222222";
    userSearchMock.mockResolvedValue([
      {
        account_id: managerAccountId,
        email_address: "ta@example.com",
      },
    ]);
    const store = {
      get: (key: string) =>
        key === "course_project_id" ? "course-project" : undefined,
    };
    const courseActions = {
      commit: jest.fn(),
      get_store: () => store,
      redux: reduxWithCourseManagers({
        managers: {
          [currentAccountId]: { group: "owner" },
          [managerAccountId]: { group: "collaborator" },
        },
      }),
      set: jest.fn(),
      syncdb: { wait_until_ready: jest.fn(async () => undefined) },
    };
    const actions = new StudentsActions(courseActions as any);

    await expect(
      actions.add_students([{ email_address: "ta@example.com" }]),
    ).rejects.toThrow("already a course manager");
    expect(courseActions.set).not.toHaveBeenCalled();
    expect(courseActions.commit).not.toHaveBeenCalled();
    expect(userSearchMock).toHaveBeenCalledWith({
      query: "ta@example.com",
      limit: 1,
      only_email: true,
    });
  });

  it("stops status polling after the course document closes", async () => {
    const getStore = jest.fn(() => {
      throw Error("store is closed");
    });
    const courseActions = {
      get_store: getStore,
      is_closed: () => true,
      syncdb: { get_state: () => "closed" },
    };
    const actions = new StudentsActions(courseActions as any);

    await expect(actions.updateStudentStatus()).resolves.toBeUndefined();
    await expect(actions.updateDeletedAccounts()).resolves.toBeUndefined();

    expect(getStore).not.toHaveBeenCalled();
  });

  it("cleans up project access before marking a student deleted", async () => {
    const student = iMap({
      email_address: "student@example.com",
      last_email_invite: Date.now(),
      project_id: "student-project",
      student_id: "student-1",
    });
    const events: string[] = [];
    const removeFromAllStudentProjects = jest.fn(async () => {
      events.push("cleanup");
    });
    const set = jest.fn((record) => {
      events.push("delete");
      expect(record).toMatchObject({
        deleted: true,
        last_email_invite: undefined,
        student_id: "student-1",
        table: "students",
      });
    });
    const courseActions = {
      get_store: () => ({ get_student: () => student }),
      set,
      student_projects: { removeFromAllStudentProjects },
    };
    const actions = new StudentsActions(courseActions as any);

    await actions.delete_student("student-1");

    expect(events).toEqual(["cleanup", "delete"]);
    expect(removeFromAllStudentProjects).toHaveBeenCalledWith(student);
  });

  it("does not mark a student deleted when invite cleanup fails", async () => {
    const cleanupError = new Error("invite cleanup failed");
    const student = iMap({ student_id: "student-1" });
    const set = jest.fn();
    const courseActions = {
      get_store: () => ({ get_student: () => student }),
      set,
      student_projects: {
        removeFromAllStudentProjects: jest.fn(async () => {
          throw cleanupError;
        }),
      },
    };
    const actions = new StudentsActions(courseActions as any);

    await expect(actions.delete_student("student-1")).rejects.toBe(
      cleanupError,
    );
    expect(set).not.toHaveBeenCalled();
  });

  it("clears stale invitation metadata when undeleting a student", async () => {
    const configureAllProjects = jest.fn(async () => undefined);
    const set = jest.fn();
    const courseActions = {
      set,
      student_projects: { configure_all_projects: configureAllProjects },
    };
    const actions = new StudentsActions(courseActions as any);

    const undeleting = actions.undelete_student("student-1");
    await jest.advanceTimersByTimeAsync(1);
    await undeleting;

    expect(set).toHaveBeenCalledWith({
      deleted: false,
      last_email_invite: undefined,
      student_id: "student-1",
      table: "students",
    });
    expect(configureAllProjects).toHaveBeenCalledTimes(1);
  });
});
