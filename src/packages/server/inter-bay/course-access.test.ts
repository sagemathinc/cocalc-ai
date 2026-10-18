/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Each bay's own answer for the course project, as its directory gives it.
const rows = new Map<string, string | null>();
const directory = jest.fn((bay_id: string) => ({
  resolveProjectBay: async () => {
    const owner = rows.get(bay_id);
    return owner ? { bay_id: owner, epoch: 0 } : null;
  },
}));
jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: () => ({ directory }),
}));
// This bay's own row must not be consulted at all.
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: () => {
    throw new Error("the receiving bay's own row is no evidence");
  },
}));

import { getHubApiRoute } from "@cocalc/conat/hub/api/routes";
import { assertSentByCourseBay } from "./course-access";

const COURSE = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  rows.clear();
  directory.mockClear();
});

it("routes course manager access, invite repair and assignment patches to the course project's bay", () => {
  for (const name of [
    "projects.ensureCourseManagerAccess",
    "projects.repairAcceptedCourseStudentInviteAccounts",
    "projects.sendCourseAssignmentPatch",
  ]) {
    const route = getHubApiRoute(name);
    expect(route?.owner).toBe("project");
    expect(
      route?.key([{ course_project_id: COURSE, project_ids: ["x"] }]),
    ).toBe(COURSE);
  }
});

it("accepts course access from the bay that says it owns the course", async () => {
  rows.set("bay-1", "bay-1");
  await expect(
    assertSentByCourseBay({
      source_bay_id: "bay-1",
      course_project_id: COURSE,
    }),
  ).resolves.toBeUndefined();
  expect(directory).toHaveBeenCalledWith("bay-1", expect.anything());
});

it("refuses a former owner after the course moved on twice (A -> B -> C)", async () => {
  // A (the receiver) still says B; B and C both say C.
  rows.set("bay-a", "bay-b");
  rows.set("bay-b", "bay-c");
  rows.set("bay-c", "bay-c");
  await expect(
    assertSentByCourseBay({
      source_bay_id: "bay-b",
      course_project_id: COURSE,
    }),
  ).rejects.toMatchObject({ code: 403 });
  await expect(
    assertSentByCourseBay({
      source_bay_id: "bay-c",
      course_project_id: COURSE,
    }),
  ).resolves.toBeUndefined();
});

it("refuses an unnamed bay, or one that knows no owner", async () => {
  await expect(
    assertSentByCourseBay({ course_project_id: COURSE }),
  ).rejects.toMatchObject({ code: 403 });
  expect(directory).not.toHaveBeenCalled();
  await expect(
    assertSentByCourseBay({
      source_bay_id: "bay-1",
      course_project_id: COURSE,
    }),
  ).rejects.toThrow("names no owner");
});
