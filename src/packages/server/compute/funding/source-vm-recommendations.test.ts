import { attachSourceVmRecommendations } from "./source-vm-recommendations";
import { getPublishedCourseVmRecommendations } from "./course-vm-recommendations";
jest.mock("./course-vm-recommendations", () => ({
  getPublishedCourseVmRecommendations: jest.fn(),
}));
const read = jest.mocked(getPublishedCourseVmRecommendations);
beforeEach(() => jest.resetAllMocks());

it("deduplicates course reads and attaches only published templates", async () => {
  read.mockResolvedValue({ templates: [], version: 3 });
  const source = {
    grant_id: "one",
    payer_account_id: "payer",
    authorized_usd: "10",
  } as any;
  const second = { ...source, grant_id: "two" };
  const course = {
    course_project_id: "project",
    course_instance_id: "instance",
  };
  await attachSourceVmRecommendations([
    { source, course },
    { source: second, course },
  ]);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith(course);
  expect(source).toEqual({
    grant_id: "one",
    payer_account_id: "payer",
    authorized_usd: "10",
    recommended_vm_templates: [],
  });
  expect(second.recommended_vm_templates).toEqual([]);
});

it("preserves a valid funding source when optional metadata cannot be loaded", async () => {
  read.mockRejectedValue(Error("course bay unavailable"));
  const source = { grant_id: "one", available_for_new_resources: true } as any;
  await attachSourceVmRecommendations([
    {
      source,
      course: { course_project_id: "project", course_instance_id: "instance" },
    },
  ]);
  expect(source).toEqual({
    grant_id: "one",
    available_for_new_resources: true,
  });
});

it("bounds concurrent project lookups", async () => {
  let active = 0;
  let peak = 0;
  read.mockImplementation(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return { templates: [], version: 0 };
  });
  await attachSourceVmRecommendations(
    Array.from({ length: 20 }, (_, i) => ({
      source: {} as any,
      course: {
        course_project_id: `project-${i}`,
        course_instance_id: "instance",
      },
    })),
  );
  expect(read).toHaveBeenCalledTimes(20);
  expect(peak).toBeLessThanOrEqual(4);
});
