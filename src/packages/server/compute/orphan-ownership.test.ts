import {
  stopOrphanProviderComputeInstance,
  deleteOrphanProviderComputeInstance,
  deleteOrphanProviderComputeAddress,
  deleteOrphanProviderComputeBootDisk,
} from "./provider";
import { getProviderContext } from "../cloud/provider-context";

jest.mock("./config", () => ({
  getComputeVmConfig: async () => ({ environment: "development" }),
}));
jest.mock("../cloud/provider-context", () => ({
  getProviderContext: jest.fn(),
}));

it.each([
  stopOrphanProviderComputeInstance,
  deleteOrphanProviderComputeInstance,
  deleteOrphanProviderComputeAddress,
  deleteOrphanProviderComputeBootDisk,
])(
  "orphan mutation rejects unproven ownership before loading credentials",
  async (mutate) => {
    const previous = process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
    process.env.COCALC_COMPUTE_DEPLOYMENT_ID = "isolated-19200";
    try {
      for (const provider of ["gcp", "nebius"] as const) {
        for (const resource_name of [
          undefined,
          "cocalc-development-vm-" + "a".repeat(24),
          "cocalc-d0000000000000000-d-vm-" + "a".repeat(24),
        ]) {
          await expect(
            mutate({
              provider,
              resource_id: "foreign-id",
              resource_name,
              region: "r",
              zone: "z",
            }),
          ).rejects.toThrow("outside this compute deployment and bay");
        }
      }
      expect(getProviderContext).not.toHaveBeenCalled();
    } finally {
      if (previous == null) delete process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
      else process.env.COCALC_COMPUTE_DEPLOYMENT_ID = previous;
    }
  },
);
