/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const resolveProjectBayMock = jest.fn();
const projectDetailsGetMock = jest.fn();
const queryMock = jest.fn();
const assertProjectNotRehomingMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => queryMock(...args) }),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "account-bay",
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: () => ({
    projectDetails: () => ({
      get: (...args: any[]) => projectDetailsGetMock(...args),
    }),
  }),
}));

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...args: any[]) => resolveProjectBayMock(...args),
}));

jest.mock("@cocalc/database/postgres/project-rehome-fence", () => ({
  assertProjectNotRehoming: (...args: any[]) =>
    assertProjectNotRehomingMock(...args),
}));

import {
  resolveAdminCourseProjectQuoteContext,
  resolveLockedLocalAdminCourseProjectQuoteContext,
} from "./admin-course-project";

const COURSE_PROJECT_ID = "00000000-2000-4000-8000-000000000001";

describe("admin course project quote context", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveProjectBayMock.mockResolvedValue({
      bay_id: "project-bay",
      epoch: 7,
    });
    projectDetailsGetMock.mockResolvedValue({
      course: { path: "assignments/course.conf" },
    });
    assertProjectNotRehomingMock.mockResolvedValue(undefined);
  });

  it("loads course facts from the owning bay with trusted admin routing", async () => {
    await expect(
      resolveAdminCourseProjectQuoteContext({
        admin_account_id: "admin-1",
        product: {
          type: "membership-package",
          kind: "course",
          membership_class: "student",
          seat_count: 10,
          course_project_id: COURSE_PROJECT_ID,
        },
      }),
    ).resolves.toEqual({
      project_id: COURSE_PROJECT_ID,
      owning_bay_id: "project-bay",
      ownership_epoch: 7,
      course_path: "assignments/course.conf",
      course_title: undefined,
    });
    expect(projectDetailsGetMock).toHaveBeenCalledWith({
      account_id: "admin-1",
      project_id: COURSE_PROJECT_ID,
      trusted_admin: true,
    });
    expect(queryMock).not.toHaveBeenCalled();
    expect(resolveProjectBayMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when ownership changes during the read", async () => {
    resolveProjectBayMock
      .mockResolvedValueOnce({ bay_id: "project-bay", epoch: 7 })
      .mockResolvedValueOnce({ bay_id: "other-bay", epoch: 8 });

    await expect(
      resolveAdminCourseProjectQuoteContext({
        admin_account_id: "admin-1",
        product: {
          type: "membership-package",
          kind: "course",
          membership_class: "student",
          seat_count: 10,
          course_project_id: COURSE_PROJECT_ID,
        },
      }),
    ).rejects.toThrow("ownership changed");
  });

  it("revalidates and locks local course facts at transactional use", async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          title: "Calculus I",
          course: { path: "assignments/course.conf" },
          owning_bay_id: "account-bay",
        },
      ],
    });
    await expect(
      resolveLockedLocalAdminCourseProjectQuoteContext({
        client: { query: queryMock } as any,
        product: {
          type: "membership-package",
          kind: "course",
          membership_class: "student",
          seat_count: 10,
          course_project_id: COURSE_PROJECT_ID,
        },
      }),
    ).resolves.toMatchObject({
      project_id: COURSE_PROJECT_ID,
      owning_bay_id: "account-bay",
      course_title: "Calculus I",
    });
    expect(assertProjectNotRehomingMock).toHaveBeenCalled();
    expect(queryMock.mock.calls[0][0]).toContain("deleted IS NOT TRUE");
    expect(queryMock.mock.calls[0][0]).toContain("FOR SHARE");
  });

  it("rejects a remote course at transactional use", async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          title: "Remote Course",
          course: { path: "course.conf" },
          owning_bay_id: "project-bay",
        },
      ],
    });
    await expect(
      resolveLockedLocalAdminCourseProjectQuoteContext({
        client: { query: queryMock } as any,
        product: {
          type: "membership-package",
          kind: "course",
          membership_class: "student",
          seat_count: 10,
          course_project_id: COURSE_PROJECT_ID,
        },
      }),
    ).rejects.toThrow("transactional project-ownership protocol");
  });
});
