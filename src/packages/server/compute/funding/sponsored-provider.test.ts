import { requireSponsoredVmProvider } from "./sponsored-provider";
import {
  reserveCourseVmLaunch,
  requireCourseVmService,
  enforceCourseVmFunding,
} from "./vm-funding";
import type { ComputeVmRow } from "../types";

test("only providers without the unrestricted paid-egress exposure can be sponsored", () => {
  expect(() => requireSponsoredVmProvider("nebius")).not.toThrow();
  expect(() => requireSponsoredVmProvider("gcp")).toThrow(
    "provider-side network spending limits",
  );
});

test("GCP cannot launch or dispatch using either new or pre-existing course metadata", async () => {
  const vm = {
    provider: "gcp",
    desired_state: "running",
    metadata: { billing: { course_funding: { source: { kind: "course" } } } },
  } as unknown as ComputeVmRow;
  await expect(reserveCourseVmLaunch(vm)).rejects.toThrow(
    "provider-side network spending limits",
  );
  await expect(requireCourseVmService(vm, true)).rejects.toThrow(
    "provider-side network spending limits",
  );
  await expect(enforceCourseVmFunding(vm)).resolves.toBe("stop");
});
