/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let getLroMock: jest.Mock;
let assertCollabRemoteMock: jest.Mock;
let cancelLroMock: jest.Mock;

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  ...jest.requireActual("@cocalc/server/lro/lro-db"),
  getLro: (...args: any[]) => getLroMock(...args),
}));

jest.mock("./util", () => ({
  __esModule: true,
  assertCollab: jest.fn(async () => undefined),
  assertCollabAllowRemoteProjectAccess: (...args: any[]) =>
    assertCollabRemoteMock(...args),
}));

jest.mock("./lro", () => ({
  __esModule: true,
  cancel: (...args: any[]) => cancelLroMock(...args),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const COURSE = "22222222-2222-4222-8222-222222222222";
const OTHER_COURSE = "33333333-3333-4333-8333-333333333333";
const OP_ID = "44444444-4444-4444-8444-444444444444";

const collection = {
  op_id: OP_ID,
  kind: "course-collect-assignment",
  scope_type: "project",
  scope_id: COURSE,
  status: "queued",
};

describe("course collection operations on the course project's bay", () => {
  beforeEach(() => {
    getLroMock = jest.fn(async () => collection);
    assertCollabRemoteMock = jest.fn(async () => undefined);
    cancelLroMock = jest.fn(async () => undefined);
  });

  it("are routed to the course project's owning bay, with collectAssignment", async () => {
    const { getHubApiRoute } = await import("@cocalc/conat/hub/api/routes");
    for (const name of [
      "collectAssignment",
      "addScheduledCollectionStudents",
      "getCourseCollectionOperation",
      "cancelCourseCollectionOperation",
    ]) {
      const route = getHubApiRoute(`projects.${name}`);
      expect([name, route?.owner]).toEqual([name, "project"]);
      expect(route?.key([{ course_project_id: COURSE }])).toBe(COURSE);
    }
  });

  it("reads a collection of the course after checking course access", async () => {
    const { getCourseCollectionOperation } = await import("./projects");
    await expect(
      getCourseCollectionOperation({
        account_id: ACCOUNT_ID,
        course_project_id: COURSE,
        op_id: OP_ID,
      }),
    ).resolves.toEqual(collection);
    expect(assertCollabRemoteMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: COURSE,
    });
  });

  it("returns nothing when this bay has no such operation", async () => {
    getLroMock = jest.fn(async () => undefined);
    const { getCourseCollectionOperation, cancelCourseCollectionOperation } =
      await import("./projects");
    const opts = {
      account_id: ACCOUNT_ID,
      course_project_id: COURSE,
      op_id: OP_ID,
    };
    await expect(getCourseCollectionOperation(opts)).resolves.toBeUndefined();
    await expect(cancelCourseCollectionOperation(opts)).resolves.toEqual({
      found: false,
    });
    expect(cancelLroMock).not.toHaveBeenCalled();
  });

  it("refuses operations of another course or of another kind", async () => {
    const { getCourseCollectionOperation, cancelCourseCollectionOperation } =
      await import("./projects");
    const opts = {
      account_id: ACCOUNT_ID,
      course_project_id: OTHER_COURSE,
      op_id: OP_ID,
    };
    await expect(getCourseCollectionOperation(opts)).rejects.toThrow(
      "not a collection operation of this course",
    );
    await expect(cancelCourseCollectionOperation(opts)).rejects.toThrow(
      "not a collection operation of this course",
    );
    getLroMock = jest.fn(async () => ({
      ...collection,
      kind: "copy-path-between-projects",
    }));
    await expect(
      getCourseCollectionOperation({ ...opts, course_project_id: COURSE }),
    ).rejects.toThrow("not a collection operation of this course");
    expect(cancelLroMock).not.toHaveBeenCalled();
  });

  it("cancels a collection of the course through lro.cancel", async () => {
    const { cancelCourseCollectionOperation } = await import("./projects");
    await expect(
      cancelCourseCollectionOperation({
        account_id: ACCOUNT_ID,
        course_project_id: COURSE,
        op_id: OP_ID,
      }),
    ).resolves.toEqual({ found: true });
    expect(cancelLroMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      op_id: OP_ID,
    });
  });
});
