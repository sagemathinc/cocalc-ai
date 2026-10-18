/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const resolveProjectBay = jest.fn();
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...args) => resolveProjectBay(...args),
}));

import { getHubApiRoute } from "@cocalc/conat/hub/api/routes";
import { assertSentByCourseBay } from "./course-access";

const COURSE = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  resolveProjectBay.mockReset();
  resolveProjectBay.mockResolvedValue({ bay_id: "bay-1", epoch: 0 });
});

it("routes course manager access and invite repair to the course project's bay", () => {
  for (const name of [
    "projects.ensureCourseManagerAccess",
    "projects.repairAcceptedCourseStudentInviteAccounts",
  ]) {
    const route = getHubApiRoute(name);
    expect(route?.owner).toBe("project");
    expect(
      route?.key([{ course_project_id: COURSE, project_ids: ["x"] }]),
    ).toBe(COURSE);
  }
});

it("accepts course access from the course project's owning bay", async () => {
  await expect(
    assertSentByCourseBay({
      source_bay_id: "bay-1",
      course_project_id: COURSE,
    }),
  ).resolves.toBeUndefined();
  expect(resolveProjectBay).toHaveBeenCalledWith(COURSE);
});

it("refuses course access from any other bay, or an unnamed one", async () => {
  await expect(
    assertSentByCourseBay({
      source_bay_id: "bay-2",
      course_project_id: COURSE,
    }),
  ).rejects.toMatchObject({ code: 403 });
  await expect(
    assertSentByCourseBay({ course_project_id: COURSE }),
  ).rejects.toMatchObject({ code: 403 });
});

it("refuses course access for an unknown course project", async () => {
  resolveProjectBay.mockResolvedValue(null);
  await expect(
    assertSentByCourseBay({
      source_bay_id: "bay-1",
      course_project_id: COURSE,
    }),
  ).rejects.toThrow("must come from its owning bay (unknown)");
});
