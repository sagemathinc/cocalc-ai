export {};

import type { CourseInfo } from "@cocalc/util/db-schema/projects";

let assertLocalProjectCollaboratorMock: jest.Mock;
let publishProjectDetailInvalidationBestEffortMock: jest.Mock;
let queryMock: jest.Mock;

jest.mock("@cocalc/server/conat/project-local-access", () => ({
  __esModule: true,
  assertLocalProjectCollaborator: (...args: any[]) =>
    assertLocalProjectCollaboratorMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/server/account/project-detail-feed", () => ({
  __esModule: true,
  publishProjectDetailInvalidationBestEffort: (...args: any[]) =>
    publishProjectDetailInvalidationBestEffortMock(...args),
}));

describe("setCourseInfo local bay access", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
  const COURSE_PROJECT_ID = "33333333-3333-4333-8333-333333333333";

  function makeCourseInfo(overrides: Partial<CourseInfo> = {}): CourseInfo {
    return {
      type: "student",
      project_id: COURSE_PROJECT_ID,
      path: ".course/main.course",
      datastore: false,
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.resetModules();
    assertLocalProjectCollaboratorMock = jest.fn(async () => undefined);
    publishProjectDetailInvalidationBestEffortMock = jest.fn(
      async () => undefined,
    );
    queryMock = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ course: undefined }] })
      .mockResolvedValueOnce({ rows: [] });
  });

  it("rejects setting course info for a project owned by another bay", async () => {
    assertLocalProjectCollaboratorMock = jest.fn(async () => {
      throw new Error("project belongs to another bay");
    });
    const { default: setCourseInfo } = await import("./set-course-info");
    await expect(
      setCourseInfo({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        course: makeCourseInfo(),
      }),
    ).rejects.toThrow("project belongs to another bay");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects setting course info when the course project is on another bay", async () => {
    assertLocalProjectCollaboratorMock = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("project belongs to another bay"));
    queryMock = jest.fn(async () => ({
      rows: [{ course: { project_id: COURSE_PROJECT_ID } }],
    }));
    const { default: setCourseInfo } = await import("./set-course-info");
    await expect(
      setCourseInfo({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        course: makeCourseInfo(),
      }),
    ).rejects.toThrow("project belongs to another bay");
    expect(assertLocalProjectCollaboratorMock).toHaveBeenNthCalledWith(1, {
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(assertLocalProjectCollaboratorMock).toHaveBeenNthCalledWith(2, {
      account_id: ACCOUNT_ID,
      project_id: COURSE_PROJECT_ID,
    });
  });

  it("updates course info when both projects are local", async () => {
    queryMock = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [{ course: { project_id: COURSE_PROJECT_ID } }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { default: setCourseInfo } = await import("./set-course-info");
    const course = makeCourseInfo({ paid: "2026-04-03T00:00:00.000Z" });
    await expect(
      setCourseInfo({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        course,
      }),
    ).resolves.toEqual({ course });
    expect(assertLocalProjectCollaboratorMock).toHaveBeenNthCalledWith(1, {
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(assertLocalProjectCollaboratorMock).toHaveBeenNthCalledWith(2, {
      account_id: ACCOUNT_ID,
      project_id: COURSE_PROJECT_ID,
    });
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      "UPDATE projects SET course=$1 WHERE project_id=$2",
      [course, PROJECT_ID],
    );
    expect(publishProjectDetailInvalidationBestEffortMock).toHaveBeenCalledWith(
      {
        project_id: PROJECT_ID,
        fields: ["course"],
      },
    );
  });
});
